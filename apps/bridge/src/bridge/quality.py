"""Capture-quality gate for a recorded pass.

The feasibility study (docs/FEASIBILITY.md §E5) found two hard requirements —
**≥100 Hz IMU** and **GPS error ≲3 m** — plus a soft one: the accelerometer must
still contain gravity, because the vertical projection is what makes the result
independent of how the phone is carried.

A detection run on a recording that fails those checks is not evidence about the
idea, it is evidence about the recording, so the CLI reports the verdict *before*
the detections and marks the detections untrustworthy when the capture is unfit.

Sample rate is graded rather than binary. A seeded sweep over 20 routes shows
precision holds (≥0.94) all the way down to 40 Hz while recall halves below
100 Hz (0.33-0.67 vs 0.73 at 100 Hz and 0.83 at 200 Hz): a slow capture makes
the detector *miss* defects, it does not make it invent them. Withholding those
findings threw away sound evidence, so ``FLOOR_FS_HZ``..``MIN_FS_HZ`` is now
degraded-but-reported and only a rate that puts the whole 20-45 Hz shock band
above Nyquist is unusable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from imukit.geo import cumulative_distance
from imukit.preprocess import G, lowpass

from .ingest import Recording

MIN_FS_HZ = 100.0
FLOOR_FS_HZ = 50.0
WARN_FS_HZ = 150.0
SHOCK_BAND_HZ = (20.0, 45.0)
MAX_GPS_ERR_M = 3.0
WARN_GPS_ERR_M = 5.0
MIN_DURATION_S = 30.0
MAX_DROPOUT_FRAC = 0.02
GRAVITY_CUTOFF_HZ = 0.4
GRAVITY_BAND_G = (0.5, 2.0)
VERDICTS = ("ok", "degraded", "unusable")


def _shock_band_covered(fs: float) -> float:
    """Fraction of the shock band that survives sampling at ``fs`` (Nyquist-limited)."""
    lo, hi = SHOCK_BAND_HZ
    return float(np.clip((fs / 2.0 - lo) / (hi - lo), 0.0, 1.0))


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
    shock_band_covered_frac: float
    gps_rate_hz: float | None
    gps_accuracy_m: float | None
    route_length_m: float | None
    verdict: str = "ok"
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return self.verdict != "unusable"

    @property
    def rate_limited(self) -> bool:
        """Usable, but sampled too slowly to see the whole shock band."""
        return self.usable and self.fs_hz < MIN_FS_HZ

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
        shock_band_covered_frac=_shock_band_covered(fs),
        gps_rate_hz=None,
        gps_accuracy_m=None,
        route_length_m=None,
    )

    if fs < FLOOR_FS_HZ:
        _fail(
            q,
            f"IMU sampled at {fs:.0f} Hz; below {FLOOR_FS_HZ:.0f} Hz the whole {SHOCK_BAND_HZ[0]:.0f}-"
            f"{SHOCK_BAND_HZ[1]:.0f} Hz shock band is above Nyquist, so there is nothing to detect",
        )
    elif fs < MIN_FS_HZ:
        _warn(
            q,
            f"IMU at {fs:.0f} Hz covers {q.shock_band_covered_frac * 100:.0f}% of the "
            f"{SHOCK_BAND_HZ[0]:.0f}-{SHOCK_BAND_HZ[1]:.0f} Hz shock band; findings stay precise but "
            f"about half of them are missed (E5: F1 0.50 at 50 Hz vs 0.80 at 100 Hz)",
        )
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
        q.gps_rate_hz = 1.0 / gdt if gdt > 0 else None
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
