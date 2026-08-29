"""Synthetic runner-on-surface IMU generator.

No real dataset was available in this hackathon repo, so the feasibility study is
driven by a physically-motivated forward model. It is intentionally simple but
reproduces the effects that determine whether detection is possible at all:

* cadence-locked footfall impacts with stride-to-stride variability;
* a surface/structure impulse response (damped modes) excited by every footfall;
* per-carry-position attenuation and broadband sensor noise;
* localized surface anomalies expressed as *changes to that impulse response*;
* an optional global structural mode whose frequency can be shifted between
  passes (the "modal frequency shift" damage indicator).

Ground truth (anomaly extents in metres along the path) is returned with the
trace so detector output can be scored automatically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from imukit.types import GpsTrack, ImuTrace

AnomalyKind = Literal["loose_slab", "wet_mat", "loose_board"]

# Baseline paving impulse response: (freq_hz, damping_ratio, amplitude)
BASELINE_MODES: tuple[tuple[float, float, float], ...] = (
    (11.0, 0.18, 1.0),
    (27.0, 0.22, 0.55),
    (52.0, 0.30, 0.25),
)


@dataclass
class Anomaly:
    kind: AnomalyKind
    start_m: float
    end_m: float

    def contains(self, d: float) -> bool:
        return self.start_m <= d <= self.end_m


@dataclass
class SurfaceScenario:
    """Everything needed to render one pass over a route."""

    length_m: float = 400.0
    speed_mps: float = 3.0
    step_freq_hz: float = 2.8
    step_freq_drift: float = 0.04  # fractional slow drift over the pass
    step_jitter_s: float = 0.012
    impact_cv: float = 0.12  # stride-to-stride impact amplitude variability
    fs: float = 200.0
    gps_hz: float = 1.0
    gps_noise_m: float = 3.0
    noise_rms: float = 0.06  # m/s^2 of broadband sensor+soft-tissue noise
    carry_gain: float = 1.0  # hand-held = 1.0, pocket ~0.6, backpack ~0.35
    struct_mode_hz: float | None = None  # global bridge mode, e.g. 6.2 Hz
    struct_mode_zeta: float = 0.02
    struct_mode_gain: float = 0.25
    anomalies: list[Anomaly] = field(default_factory=list)
    seed: int = 0


def _impulse_response(fs: float, modes, dur: float = 0.35) -> np.ndarray:
    n = int(dur * fs)
    t = np.arange(n) / fs
    h = np.zeros(n)
    for f0, zeta, amp in modes:
        h += amp * np.exp(-2 * np.pi * zeta * f0 * t) * np.sin(2 * np.pi * f0 * t)
    return h


def _anomaly_modes(kind: AnomalyKind, rng: np.random.Generator):
    """How each defect changes the local surface impulse response."""
    if kind == "loose_slab":
        # A rocking slab adds a strong, lightly damped low-frequency rattle.
        return (*BASELINE_MODES, (22.0, 0.05, 2.4)), 1.35
    if kind == "wet_mat":
        # A mat / wet patch is a compliant lossy layer: it eats high frequencies.
        damped = tuple((f, min(0.9, z * 3.0), a * (0.45 if f > 20 else 0.8)) for f, z, a in BASELINE_MODES)
        return damped, 0.75
    if kind == "loose_board":
        # A loose board rattles *after* the strike with random extra impacts.
        return (*BASELINE_MODES, (38.0, 0.08, 1.4), (63.0, 0.10, 0.9)), 1.1
    raise ValueError(f"unknown anomaly kind {kind!r}")


def simulate_pass(scn: SurfaceScenario) -> tuple[ImuTrace, GpsTrack, list[Anomaly]]:
    rng = np.random.default_rng(scn.seed)
    duration = scn.length_m / scn.speed_mps
    n = int(duration * scn.fs)
    t = np.arange(n) / scn.fs
    dist = scn.speed_mps * t

    # --- footfall times: drifting cadence + jitter -------------------------
    f_step = scn.step_freq_hz * (1 + scn.step_freq_drift * (t / max(duration, 1e-9) - 0.5))
    phase = np.cumsum(f_step) / scn.fs
    step_idx = np.flatnonzero(np.diff(np.floor(phase)) > 0) + 1
    jitter = rng.normal(0.0, scn.step_jitter_s, size=step_idx.size) * scn.fs
    step_idx = np.clip(np.round(step_idx + jitter).astype(int), 0, n - 1)

    vert = np.zeros(n)

    # --- body-motion component (the "cadence noise" to be suppressed) ------
    ph = 2 * np.pi * phase
    vert += 3.2 * np.sin(ph) + 1.1 * np.sin(2 * ph + 0.4) + 0.35 * np.sin(3 * ph + 1.1)
    vert += 0.4 * np.sin(2 * np.pi * 0.15 * t)  # slow sway / hill

    # --- per-footfall impact convolved with local surface response --------
    baseline_h = _impulse_response(scn.fs, BASELINE_MODES)
    cache: dict[AnomalyKind, tuple[np.ndarray, float]] = {}
    for i in step_idx:
        d = dist[i]
        active = next((a for a in scn.anomalies if a.contains(d)), None)
        if active is None:
            h, gain = baseline_h, 1.0
        else:
            if active.kind not in cache:
                modes, g = _anomaly_modes(active.kind, rng)
                cache[active.kind] = (_impulse_response(scn.fs, modes), g)
            h, gain = cache[active.kind]
        amp = gain * max(0.1, rng.normal(1.0, scn.impact_cv))
        seg = slice(i, min(n, i + h.size))
        vert[seg] += amp * 4.5 * h[: seg.stop - seg.start]
        if active is not None and active.kind == "loose_board":
            for _ in range(rng.integers(1, 3)):
                j = i + int(rng.uniform(0.04, 0.16) * scn.fs)
                if j + h.size < n:
                    vert[j : j + h.size] += 0.5 * amp * 4.5 * h

    # --- global structural mode (bridge span) -----------------------------
    if scn.struct_mode_hz:
        hs = _impulse_response(scn.fs, ((scn.struct_mode_hz, scn.struct_mode_zeta, 1.0),), dur=6.0)
        exc = np.zeros(n)
        exc[step_idx] = rng.normal(1.0, 0.2, size=step_idx.size)
        vert += scn.struct_mode_gain * np.convolve(exc, hs, mode="same")

    vert *= scn.carry_gain
    vert += rng.normal(0.0, scn.noise_rms, size=n)
    # 1/f-ish drift from soft-tissue coupling and thermal bias
    vert += np.cumsum(rng.normal(0.0, scn.noise_rms * 0.02, size=n))

    # --- device-frame accel with a fixed tilt and gravity ------------------
    tilt = rng.uniform(-0.25, 0.25, size=3)
    tilt /= np.linalg.norm(tilt) if np.linalg.norm(tilt) > 0 else 1.0
    ghat = np.array([0.0, 0.0, 1.0]) + 0.15 * tilt
    ghat /= np.linalg.norm(ghat)
    accel = np.outer(9.80665 + vert, ghat)
    accel += rng.normal(0.0, scn.noise_rms, size=accel.shape)

    trace = ImuTrace(
        t=t,
        accel=accel,
        fs=scn.fs,
        meta={"true_step_freq_hz": float(np.mean(f_step)), "speed_mps": scn.speed_mps},
    )
    gps = _synth_gps(scn, duration, rng)
    return trace, gps, list(scn.anomalies)


def _synth_gps(scn: SurfaceScenario, duration: float, rng: np.random.Generator) -> GpsTrack:
    """Straight north-bound route sampled at ``gps_hz`` with positional noise."""
    tg = np.arange(0.0, duration, 1.0 / scn.gps_hz)
    d = scn.speed_mps * tg
    lat0, lon0 = 51.5007, -0.1246
    m_per_deg = 111_320.0
    lat = lat0 + (d / m_per_deg) + rng.normal(0, scn.gps_noise_m / m_per_deg, size=tg.size)
    lon = np.full(tg.size, lon0) + rng.normal(
        0, scn.gps_noise_m / (m_per_deg * np.cos(np.radians(lat0))), size=tg.size
    )
    return GpsTrack(t=tg, lat=lat, lon=lon, accuracy_m=np.full(tg.size, scn.gps_noise_m))


def true_distance(scn: SurfaceScenario, t: np.ndarray) -> np.ndarray:
    """Noise-free along-path distance, for scoring localization error."""
    return scn.speed_mps * np.asarray(t, dtype=float)
