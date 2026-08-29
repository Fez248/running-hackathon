"""Capture-quality gate for a recorded pass.

The feasibility study (docs/FEASIBILITY.md §E5) found two hard requirements —
**≥100 Hz IMU** and **GPS error ≲3 m** — plus a soft one: the accelerometer must
still contain gravity, because the vertical projection is what makes the result
independent of how the phone is carried.

A detection run on a recording that fails those checks is not evidence about the
idea, it is evidence about the recording, so the CLI reports the verdict *before*
the detections and marks the detections untrustworthy when the capture is unfit.

Sample rate is graded rather than binary. A seeded sweep (§E6) shows a slow
capture costs *recall*, not precision: 41-90 Hz scores 0.97-1.00 precision at
0.33-0.67 recall, against 0.94/0.70 at the nominal 100 Hz and 0.91/0.90 at
200 Hz — a slow pass misses defects rather than inventing them, and is no more
false-positive prone than a fast one. Withholding its findings threw away sound
evidence, so ``FLOOR_FS_HZ``..``MIN_FS_HZ`` is degraded-but-reported and only a
rate that leaves *nothing* of the shock band below Nyquist is unusable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from imukit.geo import cumulative_distance
from imukit.preprocess import G, dc_magnitude

from .ingest import Recording

MIN_FS_HZ = 100.0
WARN_FS_HZ = 150.0
SHOCK_BAND_HZ = (20.0, 45.0)
FLOOR_FS_HZ = 2.0 * SHOCK_BAND_HZ[0]  # Nyquist: below this the shock band is gone entirely
MAX_GPS_ERR_M = 3.0
WARN_GPS_ERR_M = 5.0
MIN_DURATION_S = 30.0
MAX_DROPOUT_FRAC = 0.02
GRAVITY_CUTOFF_HZ = 0.4
GRAVITY_BAND_G = (0.5, 2.0)
VERDICTS = ("ok", "degraded", "unusable")


def _shock_band_covered(fs: float) -> float:
    """Fraction of the shock band that survives sampling at ``fs`` (Nyquist-limited).

    Rounded at the bottom so a rate that only clears ``FLOOR_FS_HZ`` by timestamp
    noise reads as the zero coverage it physically is.
    """
    lo, hi = SHOCK_BAND_HZ
    return round(float(np.clip((fs / 2.0 - lo) / (hi - lo), 0.0, 1.0)), 6)


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
    dc_mag = dc_magnitude(rec.trace.accel, fs, GRAVITY_CUTOFF_HZ)
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

    if q.shock_band_covered_frac <= 0.0:
        _fail(
            q,
            f"IMU sampled at {fs:.0f} Hz; at or below {FLOOR_FS_HZ:.0f} Hz the whole {SHOCK_BAND_HZ[0]:.0f}-"
            f"{SHOCK_BAND_HZ[1]:.0f} Hz shock band is above Nyquist, so there is nothing to detect",
        )
    elif fs < MIN_FS_HZ:
        _warn(
            q,
            f"IMU at {fs:.0f} Hz covers {q.shock_band_covered_frac * 100:.0f}% of the "
            f"{SHOCK_BAND_HZ[0]:.0f}-{SHOCK_BAND_HZ[1]:.0f} Hz shock band; findings are no less "
            f"trustworthy than at 100 Hz, but about half of the defects are missed "
            f"(E6: recall 0.33-0.67 vs 0.70 at 100 Hz)",
        )
    elif fs < WARN_FS_HZ:
        _warn(q, f"IMU at {fs:.0f} Hz is the minimum viable rate; 200 Hz keeps the 20-80 Hz shock band")
    if q.duration_s < MIN_DURATION_S:
        _fail(q, f"pass is {q.duration_s:.0f} s; the robust baseline needs ≥{MIN_DURATION_S:.0f} s")
    if not q.gravity_present:
        _fail(
            q,
            f"DC |a| is {dc_mag:.2f} m/s^2, not ~{G:.1f}: gravity removed (linear-acceleration "
            "stream), so the vertical axis cannot be projected; if the export has a Gravity.csv "
            "the ingester reconstructs the total, otherwise record total acceleration",
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
