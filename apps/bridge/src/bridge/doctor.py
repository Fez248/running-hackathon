"""``bridge doctor``: what to change before the next recording.

Every unusable recording so far cost a walk outside to discover, because the
capture was only ever judged after it had been carried home and scanned. This
reads a recording and prints the settings to change, in the vocabulary of the
recorder app rather than of the detector.

The measured facts it exists to encode: an iPhone 12 Pro Max asked for a 5 ms
interval with nine sensors enabled delivered 99.95 Hz, not 200 Hz, and Sensor
Logger's ``AccelerometerUncalibrated.csv`` is in g, so a capture whose gravity
is intact can still look gravity-free if it is read at face value. Both are
recording-time settings, and both are invisible until something says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from imukit.preprocess import G

from .ingest import Recording
from .quality import MIN_FS_HZ, WARN_GPS_ERR_M, assess

# Above this many enabled streams, Sensor Logger stops keeping up with a fast
# sample interval on an iPhone. Nine sensors at a requested 5 ms measured
# 99.95 Hz — half the requested rate, and the reason a pass came home degraded.
MAX_SENSORS_FOR_FAST_RATE = 4

# What the scan actually consumes. Everything else costs sample rate and buys
# nothing, which is the whole recommendation.
REQUIRED_SENSORS = ("accelerometer", "location")

# A requested rate is "met" within this fraction; phones round sample intervals.
RATE_TOLERANCE = 0.9


@dataclass
class Diagnosis:
    """A recording's capture settings, and what to change about them."""

    source: str
    verdict: str
    measured_fs_hz: float
    requested_fs_hz: float | None
    duration_s: float
    dropout_frac: float
    jitter_ms: float
    gravity_present: bool
    unit_scale: float
    n_sensors: int
    sensors: list[str] = field(default_factory=list)
    gps_present: bool = False
    gps_rate_hz: float | None = None
    gps_accuracy_p50_m: float | None = None
    gps_accuracy_p90_m: float | None = None
    gps_accuracy_worst_m: float | None = None
    gps_frac_over_5m: float | None = None
    #: Plain-language, imperative, one per line: what to do before the next pass.
    advice: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def _percentile(values: np.ndarray, p: float) -> float:
    return float(np.percentile(values, p))


def diagnose(rec: Recording) -> Diagnosis:
    """Read a recording and say what to change before the next one."""
    q = assess(rec)
    p = rec.provenance
    sensors = list(p.sensors)
    d = Diagnosis(
        source=rec.source,
        verdict=q.verdict,
        measured_fs_hz=q.fs_hz,
        requested_fs_hz=p.requested_fs_hz,
        duration_s=q.duration_s,
        dropout_frac=q.dropout_frac,
        jitter_ms=q.jitter_ms,
        gravity_present=q.gravity_present,
        unit_scale=p.unit_scale,
        n_sensors=len(sensors),
        sensors=sensors,
        gps_present=q.gps_present,
        gps_rate_hz=q.gps_rate_hz,
    )

    acc = None if rec.gps is None else rec.gps.accuracy_m
    if acc is not None and acc.size:
        acc = np.asarray(acc, dtype=float)
        acc = acc[np.isfinite(acc)]
    if acc is not None and acc.size:
        d.gps_accuracy_p50_m = _percentile(acc, 50)
        d.gps_accuracy_p90_m = _percentile(acc, 90)
        d.gps_accuracy_worst_m = float(np.max(acc))
        d.gps_frac_over_5m = float(np.mean(acc > WARN_GPS_ERR_M))

    d.advice = _advice(d)
    return d


def _advice(d: Diagnosis) -> list[str]:
    advice: list[str] = []

    if d.requested_fs_hz and d.measured_fs_hz < RATE_TOLERANCE * d.requested_fs_hz:
        advice.append(
            f"the recorder was asked for {d.requested_fs_hz:.0f} Hz and delivered "
            f"{d.measured_fs_hz:.1f} Hz. The phone cannot keep up with the interval it "
            "accepted; the sensors enabled alongside the accelerometer are what it "
            "spends the difference on."
        )
    if d.measured_fs_hz < MIN_FS_HZ:
        advice.append(
            f"sample rate {d.measured_fs_hz:.1f} Hz is below the {MIN_FS_HZ:.0f} Hz the shock "
            "band needs. Roughly half the defects are invisible at this rate, so an empty "
            "result would not mean a sound surface."
        )

    lowered = {s.lower().replace(" ", "") for s in d.sensors}
    extra = sorted(
        s
        for s in d.sensors
        if not any(req in s.lower().replace(" ", "") for req in REQUIRED_SENSORS)
    )
    if d.n_sensors > MAX_SENSORS_FOR_FAST_RATE:
        advice.append(
            f"{d.n_sensors} sensors were enabled. On an iPhone 12 Pro Max, nine sensors at a "
            "requested 5 ms delivered 99.95 Hz instead of 200 Hz. Enable Accelerometer and "
            f"Location only; turn off {', '.join(extra[:8])}."
        )
    if not any("location" in s for s in lowered) and not d.gps_present:
        advice.append(
            "no Location stream: findings cannot be placed on the map. Enable Location in the "
            "recorder before the next pass."
        )

    if not d.gravity_present:
        advice.append(
            f"the accelerometer stream carries no gravity (DC is not ~{G:.1f} m/s^2), so the "
            "vertical axis cannot be projected. Record Total Acceleration, or enable Gravity "
            "alongside Accelerometer so the total can be reconstructed at ingest."
        )
    if d.unit_scale != 1.0:
        advice.append(
            f"the accelerometer stream was in g and has been scaled by {d.unit_scale:.5f} to "
            "m/s^2. Nothing to change on the phone; this is what "
            "AccelerometerUncalibrated.csv reports."
        )

    if d.gps_accuracy_p50_m is not None:
        if d.gps_frac_over_5m and d.gps_frac_over_5m > 0.5:
            advice.append(
                f"{d.gps_frac_over_5m:.0%} of fixes are worse than {WARN_GPS_ERR_M:.0f} m "
                f"(median {d.gps_accuracy_p50_m:.1f} m, worst {d.gps_accuracy_worst_m:.0f} m). "
                "Give the phone a minute of open sky before starting, and keep it out of a "
                "pocket against the body; findings from this pass are located to tens of metres."
            )
        elif d.gps_accuracy_p50_m > WARN_GPS_ERR_M:
            advice.append(
                f"median GPS accuracy {d.gps_accuracy_p50_m:.1f} m is over the "
                f"{WARN_GPS_ERR_M:.0f} m limit. Wait for the fix to settle before starting the "
                "recording."
            )
    if d.dropout_frac > 0.02:
        advice.append(
            f"{d.dropout_frac:.1%} of samples arrived late or not at all. Close other apps and "
            "keep the screen on for the next pass."
        )
    if not advice:
        advice.append("nothing to change: this capture is fit to scan as recorded.")
    return advice


def format_diagnosis(d: Diagnosis) -> str:
    """The report ``bridge doctor`` prints."""
    requested = "unstated" if not d.requested_fs_hz else f"{d.requested_fs_hz:.0f} Hz"
    lines = [
        f"recording     {d.source}",
        f"verdict       {d.verdict.upper()}",
        f"sample rate   {d.measured_fs_hz:.1f} Hz measured, {requested} requested"
        f"  (jitter p95 {d.jitter_ms:.1f} ms, dropouts {d.dropout_frac:.2%})",
        f"duration      {d.duration_s:.0f} s",
        f"gravity       {'present' if d.gravity_present else 'ABSENT'}"
        + (f", stream scaled by {d.unit_scale:.5f} (was in g)" if d.unit_scale != 1.0 else ""),
        f"sensors       {d.n_sensors}: {', '.join(d.sensors) if d.sensors else 'unknown'}",
    ]
    if d.gps_accuracy_p50_m is not None:
        rate = "unknown rate" if d.gps_rate_hz is None else f"{d.gps_rate_hz:.1f} Hz"
        lines.append(
            f"gps           {rate}, accuracy p50 {d.gps_accuracy_p50_m:.1f} m / "
            f"p90 {d.gps_accuracy_p90_m:.1f} m / worst {d.gps_accuracy_worst_m:.0f} m, "
            f"{d.gps_frac_over_5m:.0%} of fixes over {WARN_GPS_ERR_M:.0f} m"
        )
    elif d.gps_present:
        lines.append("gps           present, but no per-fix accuracy reported")
    else:
        lines.append("gps           none")
    lines.append("before the next recording")
    lines += [f"  - {a}" for a in d.advice]
    return "\n".join(lines)
