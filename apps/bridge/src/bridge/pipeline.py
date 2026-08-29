"""Signal-processing pipeline: separate cadence from surface/structural response.

Stages
------
1. resample to a uniform grid (phone timestamps jitter);
2. gravity-aligned vertical projection (carry-position invariance);
3. cadence estimation + footfall detection;
4. **stride-template suppression** - the core idea: the periodic, runner-specific
   part of the signal is estimated as a phase-normalized robust template and
   subtracted, leaving a residual dominated by surface/structure response;
5. windowed features on the residual;
6. GPS projection of every window onto along-path distance.

The residual is what makes anomaly detection tractable: without step 4 the
window features are dominated by stride-to-stride amplitude variation (which is
runner/fatigue driven) instead of by the surface.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from imukit.cadence import CadenceEstimate, detect_footfalls, resolve_step_frequency, stride_segments
from imukit.features import window_features
from imukit.geo import distance_at_times, median_speed_mps
from imukit.preprocess import bandpass, gravity_split, resample_uniform
from imukit.types import GpsTrack, ImuTrace

TEMPLATE_LEN = 96  # phase bins per stride cycle


@dataclass
class ProcessedPass:
    t: np.ndarray
    vert: np.ndarray
    residual: np.ndarray
    fs: float
    f_step: float
    footfalls: np.ndarray
    window_t: np.ndarray
    window_distance_m: np.ndarray
    features: dict[str, np.ndarray]
    template: np.ndarray
    #: The step frequency and the cross-checks that settled it.
    cadence: CadenceEstimate | None = None

    @property
    def n_windows(self) -> int:
        return int(self.window_t.size)


def _phase_resample(seg: np.ndarray, length: int) -> np.ndarray:
    x = np.linspace(0.0, 1.0, seg.size)
    return np.interp(np.linspace(0.0, 1.0, length), x, seg)


def stride_template(x: np.ndarray, segments: list[tuple[int, int]], length: int = TEMPLATE_LEN) -> np.ndarray:
    """Median phase-normalized stride shape (robust to anomalous strides)."""
    if not segments:
        return np.zeros(length)
    stack = np.array([_phase_resample(x[a:b], length) for a, b in segments if b - a >= 4])
    if stack.size == 0:
        return np.zeros(length)
    return np.median(stack, axis=0)


def suppress_cadence(
    x: np.ndarray,
    segments: list[tuple[int, int]],
    template: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Subtract an amplitude-fitted stride template from every stride.

    Per stride the template is stretched to the stride length and scaled by the
    least-squares gain, so cadence drift and per-step effort changes do not leak
    into the residual. Amplitude fitting is what keeps a genuinely harder impact
    (loose slab) in the residual while removing ordinary effort variation, because
    a defect changes the *shape*, not just the gain.
    """
    tmpl = stride_template(x, segments) if template is None else template
    residual = x.copy()
    for a, b in segments:
        if b - a < 4:
            continue
        pred = _phase_resample(tmpl, b - a)
        denom = float(pred @ pred)
        gain = float(pred @ x[a:b] / denom) if denom > 1e-12 else 0.0
        residual[a:b] = x[a:b] - gain * pred
    # Outside the first/last footfall we have no stride model; zero it to avoid
    # spurious detections at the trace edges.
    if segments:
        residual[: segments[0][0]] = 0.0
        residual[segments[-1][1] :] = 0.0
    return residual, tmpl


def make_windows(n: int, fs: float, win_sec: float, hop_sec: float) -> list[tuple[int, int]]:
    w = int(win_sec * fs)
    h = int(hop_sec * fs)
    return [(s, s + w) for s in range(0, max(0, n - w + 1), h)]


def process_pass(
    trace: ImuTrace,
    gps: GpsTrack | None = None,
    fs_target: float = 200.0,
    win_sec: float = 1.5,
    hop_sec: float = 0.75,
    residual_band: tuple[float, float] = (4.0, 80.0),
) -> ProcessedPass:
    t, accel = resample_uniform(trace.t, trace.accel, fs_target)
    uniform = ImuTrace(t=t, accel=accel, fs=fs_target, meta=dict(trace.meta))
    vert, _horiz = gravity_split(uniform)

    # Ground speed is what makes the step/stride ambiguity decidable, so the
    # cadence estimate is given the GPS before the stride model is built on it.
    speed = median_speed_mps(gps) if gps is not None and gps.t.size >= 3 else None
    if not speed:
        speed = float(trace.meta.get("speed_mps", 0.0)) or None
    cadence = resolve_step_frequency(vert, fs_target, speed_mps=speed)
    f_step = cadence.f_step
    footfalls = detect_footfalls(vert, fs_target, f_step=f_step)
    segments = stride_segments(footfalls, len(vert))
    residual, tmpl = suppress_cadence(vert, segments)
    # Keep only the band where surface/structure response lives; below ~4 Hz the
    # residual is dominated by template mismatch, above 80 Hz by sensor noise.
    residual = bandpass(residual, fs_target, residual_band[0], min(residual_band[1], fs_target / 2 * 0.95))

    wins = make_windows(len(residual), fs_target, win_sec, hop_sec)
    feats: dict[str, list[float]] = {}
    wt = []
    for a, b in wins:
        wf = window_features(residual[a:b], fs_target)
        for k, v in wf.items():
            feats.setdefault(k, []).append(v)
        wt.append(float(t[(a + b) // 2]))
    window_t = np.asarray(wt)
    if gps is not None and gps.t.size >= 2:
        wd = distance_at_times(gps, window_t)
    else:
        speed = float(trace.meta.get("speed_mps", 0.0))
        wd = speed * (window_t - (window_t[0] if window_t.size else 0.0))

    return ProcessedPass(
        t=t,
        vert=vert,
        residual=residual,
        fs=fs_target,
        f_step=f_step,
        footfalls=footfalls,
        window_t=window_t,
        window_distance_m=np.asarray(wd, dtype=float),
        features={k: np.asarray(v, dtype=float) for k, v in feats.items()},
        template=tmpl,
        cadence=cadence,
    )
