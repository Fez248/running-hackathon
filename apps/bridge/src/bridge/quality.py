"""Capture-quality gate for a recorded pass.

The feasibility study (docs/FEASIBILITY.md §E5) found two hard requirements —
**≥100 Hz IMU** and **GPS error ≲3 m** — plus a soft one: the accelerometer must
still contain gravity, because the vertical projection is what makes the result
independent of how the phone is carried.

A detection run on a recording that fails those checks is not evidence about the
idea, it is evidence about the recording, so the CLI reports the verdict *before*
the detections and marks the detections untrustworthy when the capture is unfit.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from imukit.geo import cumulative_distance
from imukit.preprocess import G, lowpass

from .ingest import Recording

MIN_FS_HZ = 100.0
WARN_FS_HZ = 150.0
MAX_GPS_ERR_M = 3.0
WARN_GPS_ERR_M = 5.0
MIN_DURATION_S = 30.0
MAX_DROPOUT_FRAC = 0.02
GRAVITY_CUTOFF_HZ = 0.4
GRAVITY_BAND_G = (0.5, 2.0)
VERDICTS = ("ok", "degraded", "unusable")


def _dc_magnitude(accel: np.ndarray, fs: float) -> float:
    """Median magnitude of the sub-``GRAVITY_CUTOFF_HZ`` component of ``accel``.

    Gait and orientation changes live above that cutoff, so the low-passed norm
    is ~g for a gravity-carrying stream and ~0 for a linear/user-acceleration
    one however vigorous the motion — the mean raw norm is not, because hard
    running averages well above 0.5 g with gravity already removed.
    """
    if fs <= 4 * GRAVITY_CUTOFF_HZ or accel.shape[0] < 64:
        return float(np.linalg.norm(np.mean(accel, axis=0)))
    return float(np.median(np.linalg.norm(lowpass(accel, fs, GRAVITY_CUTOFF_HZ), axis=1)))


@dataclass
class CaptureQuality:
    fs_hz: float
    jitter_ms: float
    dropout_frac: float
    duration_s: float
    gravity_present: bool
    clipping_frac: float
    gps_present: bool
    gps_rate_hz: float | None
    gps_accuracy_m: float | None
    route_length_m: float | None
    verdict: str = "ok"
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return self.verdict != "unusable"

    def as_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items()}
        d["usable"] = self.usable
        return d


def _fail(q: CaptureQuality, msg: str) -> None:
    q.problems.append(msg)
    q.verdict = "unusable"


def _warn(q: CaptureQuality, msg: str) -> None:
    q.warnings.append(msg)
    if q.verdict == "ok":
        q.verdict = "degraded"


def assess(rec: Recording) -> CaptureQuality:
    """Score a recording against the requirements the feasibility study derived."""
    t = rec.trace.t
    dt = np.diff(t)
    dt_med = float(np.median(dt)) if dt.size else 0.0
    fs = 1.0 / dt_med if dt_med > 0 else 0.0
    dc_mag = _dc_magnitude(rec.trace.accel, fs)
    lo_g, hi_g = GRAVITY_BAND_G
    q = CaptureQuality(
        fs_hz=fs,
        jitter_ms=float(np.percentile(np.abs(dt - dt_med), 95) * 1e3) if dt.size else 0.0,
        dropout_frac=float(np.mean(dt > 3 * dt_med)) if dt.size else 0.0,
        duration_s=rec.trace.duration,
        gravity_present=bool(lo_g * G < dc_mag < hi_g * G),
        clipping_frac=float(np.mean(np.max(np.abs(rec.trace.accel), axis=1) >= 4 * G)),
        gps_present=rec.gps is not None,
        gps_rate_hz=None,
        gps_accuracy_m=None,
        route_length_m=None,
    )

    if fs < MIN_FS_HZ:
        _fail(q, f"IMU sampled at {fs:.0f} Hz; ≥{MIN_FS_HZ:.0f} Hz is required (E5: F1 0.50 at 50 Hz)")
    elif fs < WARN_FS_HZ:
        _warn(q, f"IMU at {fs:.0f} Hz is the minimum viable rate; 200 Hz keeps the 20-80 Hz shock band")
    if q.duration_s < MIN_DURATION_S:
        _fail(q, f"pass is {q.duration_s:.0f} s; the robust baseline needs ≥{MIN_DURATION_S:.0f} s")
    if not q.gravity_present:
        _fail(
            q,
            f"DC |a| is {dc_mag:.2f} m/s², not ~{G:.1f}: gravity removed (linear-acceleration "
            "stream), so the vertical axis cannot be projected",
        )
    if q.dropout_frac > MAX_DROPOUT_FRAC:
        _warn(q, f"{q.dropout_frac * 100:.1f}% of sample gaps are >3x nominal (dropped samples)")
    if q.clipping_frac > 0.001:
        _warn(q, f"{q.clipping_frac * 100:.1f}% of samples at ≥4g — accelerometer range clipping")

    if rec.gps is not None and rec.gps.t.size >= 2:
        gdt = float(np.median(np.diff(rec.gps.t)))
        if gdt <= 0:
            # A zero interval also makes the time-based route smoothing unbounded.
            _fail(q, "GPS timestamps do not increase; the track has no usable sampling interval")
            return q
        q.gps_rate_hz = 1.0 / gdt
        q.route_length_m = float(cumulative_distance(rec.gps, smooth_s=5.0)[-1])
        if rec.gps.accuracy_m is not None and rec.gps.accuracy_m.size:
            q.gps_accuracy_m = float(np.median(rec.gps.accuracy_m))
            if q.gps_accuracy_m > WARN_GPS_ERR_M:
                _fail(
                    q,
                    f"median GPS accuracy {q.gps_accuracy_m:.1f} m; localization collapses beyond "
                    f"~{WARN_GPS_ERR_M:.0f} m (E5: F1 0.00 at 8 m)",
                )
            elif q.gps_accuracy_m > MAX_GPS_ERR_M:
                _warn(q, f"median GPS accuracy {q.gps_accuracy_m:.1f} m; ≤{MAX_GPS_ERR_M:.0f} m is the goal")
        else:
            _warn(q, "GPS track has no accuracy column; localization error is unknown")
    else:
        _fail(q, "no usable GPS track: findings cannot be placed along the route, record GPS too")
    return q
