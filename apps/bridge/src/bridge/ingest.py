"""Load *real* phone recordings into ``ImuTrace`` / ``GpsTrack``.

Everything else in this app runs on the synthetic forward model. This module is
the missing half: it takes what an off-the-shelf logging app on a phone actually
exports and hands the pipeline the same containers the simulator produces, so a
recorded pass and a simulated pass go through exactly the same code path.

Supported inputs (auto-detected):

* **Sensor Logger** (iOS/Android) export directory or ``.zip`` —
  ``Accelerometer.csv`` + ``Gravity.csv``, ``TotalAcceleration.csv`` or
  ``AccelerometerUncalibrated.csv``, plus ``Location.csv``;
* **phyphox** export directory or ``.zip`` — ``Accelerometer.csv`` /
  ``Location.csv`` with ``"Time (s)"``-style headers, comma or semicolon
  separated;
* **generic CSV** — a time column plus three acceleration columns, with an
  optional separate GPS CSV (``t,lat,lon[,accuracy_m]``).

Everything downstream projects acceleration onto gravity, so the total
acceleration is normalised here rather than assumed: it is reconstructed when
the export only ships its parts, and converted to m/s² when the stream was
logged in *g* (see :func:`to_ms2`). Only a stream that carries no gravity at all
reaches the quality gate as such.

Only stdlib + numpy are used; the exports are small enough that a streaming
reader is not worth the dependency.
"""

from __future__ import annotations

import csv
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from imukit.preprocess import G, lowpass
from imukit.types import GpsTrack, ImuTrace

# Header aliases, lower-cased and stripped of units/punctuation.
# `seconds_elapsed` first: Sensor Logger writes it alongside an epoch-ns `time`,
# and a relative column shared by every stream is the least ambiguous clock.
TIME_KEYS = ("seconds elapsed", "t", "time s", "time sec", "time", "times", "timestamp")
ACCEL_KEYS = {
    "x": ("x", "ax", "accel x", "acceleration x", "accelerometer x", "acc x"),
    "y": ("y", "ay", "accel y", "acceleration y", "accelerometer y", "acc y"),
    "z": ("z", "az", "accel z", "acceleration z", "accelerometer z", "acc z"),
}
LAT_KEYS = ("lat", "latitude")
LON_KEYS = ("lon", "lng", "longitude")
ACC_KEYS = ("accuracy m", "accuracy", "horizontalaccuracy", "horizontal accuracy m", "horizontal accuracy")

# Sensor Logger writes epoch nanoseconds in `time`; phyphox writes seconds since
# recording start. Epoch-scale magnitudes disambiguate the unit.
NS_THRESHOLD = 1e15
MS_THRESHOLD = 1e11
DEMO_EPOCH_NS = 1_700_000_000_000_000_000

# An hour at 400 Hz is ~150 MB of CSV; anything far past that is not a pass we
# can interpret, so refuse it rather than read it into memory.
MAX_TABLE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024

# Gravity sits below GRAVITY_CUTOFF_HZ, gait and orientation changes above it, so
# the low-passed norm of a gravity-carrying stream is the gravity magnitude in
# whatever unit the stream was logged: ~1 for *g*, ~9.81 for m/s². The band is
# wide because a phone carried by a runner is neither still nor level.
GRAVITY_CUTOFF_HZ = 0.4
GRAVITY_BAND_G = (0.5, 2.0)
# Relative interquartile spread of the DC magnitude above which a ~1-magnitude
# stream is low-frequency residue rather than gravity logged in *g*.
MAX_GRAVITY_DC_SPREAD = 0.25


@dataclass
class Recording:
    """One recorded pass: IMU (+ GPS) plus provenance and caveats."""

    trace: ImuTrace
    gps: GpsTrack | None
    source: str
    format: str
    notes: list[str] = field(default_factory=list)


def _normalize(name: str) -> str:
    """``"Acceleration x (m/s^2)"`` -> ``"acceleration x"``."""
    head = name.split("(")[0]
    keep = [c.lower() if (c.isalnum() or c == " ") else " " for c in head]
    return " ".join("".join(keep).split())


def read_table(path: Path) -> dict[str, np.ndarray]:
    """Read a delimited text table into ``{normalized_header: float column}``."""
    size = path.stat().st_size
    if size > MAX_TABLE_BYTES:
        raise ValueError(f"{path}: {size / 1e6:.0f} MB exceeds the {MAX_TABLE_BYTES / 1e6:.0f} MB limit")
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise ValueError(f"{path}: need a header and at least one data row")
    try:
        dialect = csv.Sniffer().sniff(lines[0], delimiters=",;\t")
        delim = dialect.delimiter
    except csv.Error:
        delim = ","
    rows = list(csv.reader(lines, delimiter=delim))
    header = [_normalize(h) for h in rows[0]]
    cols: dict[str, list[float]] = {h: [] for h in header}
    for row in rows[1:]:
        if len(row) < len(header):
            continue
        for h, cell in zip(header, row, strict=False):
            try:
                cols[h].append(float(cell))
            except ValueError:
                cols[h].append(np.nan)
    return {h: np.asarray(v, dtype=float) for h, v in cols.items()}


def _pick(cols: dict[str, np.ndarray], keys: tuple[str, ...]) -> np.ndarray | None:
    for k in keys:
        if k in cols:
            return cols[k]
    # Prefix fallback for headers carrying extra words ("acceleration x axis").
    # Single-letter keys are excluded: "t" would happily match "temperature".
    for name, values in cols.items():
        if any(len(k) > 2 and name.startswith(k) for k in keys):
            return values
    return None


def _seconds(t: np.ndarray) -> np.ndarray:
    """Epoch-ns / epoch-ms columns -> seconds, origin at the first sample."""
    t = np.asarray(t, dtype=float)
    if t.size and np.nanmax(np.abs(t)) > NS_THRESHOLD:
        t = t / 1e9
    elif t.size and np.nanmax(np.abs(t)) > MS_THRESHOLD:
        t = t / 1e3
    return t


def _clean(t: np.ndarray, *cols: np.ndarray) -> tuple[np.ndarray, ...]:
    """Drop NaN rows and sort by time (phone exports are not always ordered)."""
    good = np.isfinite(t)
    for c in cols:
        good &= np.isfinite(c)
    order = np.argsort(t[good], kind="stable")
    return tuple(np.asarray(c)[good][order] for c in (t, *cols))


def _trace_from_table(cols: dict[str, np.ndarray], t0: float | None = None) -> tuple[ImuTrace, float]:
    t_raw = _pick(cols, TIME_KEYS)
    axis = {k: _pick(cols, v) for k, v in ACCEL_KEYS.items()}
    if t_raw is None or any(v is None for v in axis.values()):
        raise ValueError(f"missing time or x/y/z acceleration columns; found {sorted(cols)}")
    t = _seconds(t_raw)
    t, ax, ay, az = _clean(t, axis["x"], axis["y"], axis["z"])
    if t.size < 2:
        raise ValueError("fewer than two usable acceleration samples")
    origin = t[0] if t0 is None else t0
    t = t - origin
    fs = float(1.0 / np.median(np.diff(t))) if t.size > 1 else 0.0
    return ImuTrace(t=t, accel=np.column_stack([ax, ay, az]), fs=fs), origin


def dc_magnitude(accel: np.ndarray, fs: float) -> float:
    """Median magnitude of the sub-``GRAVITY_CUTOFF_HZ`` component of ``accel``.

    Gait and orientation changes live above that cutoff, so the low-passed norm
    is ~g for a gravity-carrying stream and ~0 for a linear/user-acceleration
    one however vigorous the motion — the mean raw norm is not, because hard
    running averages well above 0.5 g with gravity already removed.
    """
    if fs <= 4 * GRAVITY_CUTOFF_HZ or accel.shape[0] < 64:
        return float(np.linalg.norm(np.mean(accel, axis=0)))
    return float(np.median(np.linalg.norm(lowpass(accel, fs, GRAVITY_CUTOFF_HZ), axis=1)))


def dc_steadiness(accel: np.ndarray, fs: float) -> float:
    """Interquartile spread of the DC magnitude, relative to its median.

    Gravity has a constant magnitude however the phone tumbles, so its DC norm
    is flat (~0.06 on a recorded run); the low-frequency residue left in a
    gravity-free stream wanders instead (~0.8). That is what separates a
    ~1-magnitude stream logged in *g* from a vigorous stream in m/s² whose
    residual DC happens to sit near 1.
    """
    if fs <= 4 * GRAVITY_CUTOFF_HZ or accel.shape[0] < 64:
        return 0.0
    norm = np.linalg.norm(lowpass(accel, fs, GRAVITY_CUTOFF_HZ), axis=1)
    median = float(np.median(norm))
    if median <= 0:
        return float("inf")
    return float(np.subtract(*np.percentile(norm, [75, 25]))) / median


def to_ms2(trace: ImuTrace) -> tuple[ImuTrace, float, str]:
    """Normalise a gravity-carrying stream to m/s²; return it with its scale and a note.

    Sensor Logger's calibrated streams are m/s², but its uncalibrated one (and
    several Android builds) export *g*, where a total acceleration reads ~1.00
    instead of ~9.81 — indistinguishable from a gravity-free stream to anything
    that only looks at the magnitude. The DC magnitude names the unit: it is the
    gravity constant as the exporter wrote it, provided it is steady enough to be
    gravity at all (see :func:`dc_steadiness`).

    A stream whose DC magnitude matches neither unit carries no gravity to scale
    by, so it is returned untouched for the quality gate to refuse.
    """
    dc = dc_magnitude(trace.accel, trace.fs)
    lo, hi = GRAVITY_BAND_G
    if lo < dc < hi and dc_steadiness(trace.accel, trace.fs) <= MAX_GRAVITY_DC_SPREAD:
        scaled = ImuTrace(t=trace.t, accel=trace.accel * G, fs=trace.fs)
        return scaled, G, f"acceleration was in g (DC |a| {dc:.3f} g), scaled by {G:.5f} to m/s²"
    if lo * G < dc < hi * G:
        return trace, 1.0, f"acceleration already in m/s² (DC |a| {dc:.2f} m/s²), scale 1.0"
    return trace, 1.0, (
        f"DC |a| is {dc:.3f}: neither ~1 g nor ~{G:.1f} m/s², so there is no gravity to scale by"
    )


def _gps_from_table(cols: dict[str, np.ndarray], t0: float) -> GpsTrack | None:
    t_raw, lat, lon = _pick(cols, TIME_KEYS), _pick(cols, LAT_KEYS), _pick(cols, LON_KEYS)
    if t_raw is None or lat is None or lon is None:
        return None
    acc = _pick(cols, ACC_KEYS)
    if acc is not None and not np.any(np.isfinite(acc)):
        # A column of blanks is an absent accuracy report, not an invalid fix.
        acc = None
    t = _seconds(t_raw)
    if acc is None:
        t, lat, lon = _clean(t, lat, lon)
        acc_clean = None
    else:
        t, lat, lon, acc_clean = _clean(t, lat, lon, acc)
    if t.size < 2:
        return None
    return GpsTrack(t=t - t0, lat=lat, lon=lon, accuracy_m=acc_clean)


def _find(directory: Path, *stems: str) -> Path | None:
    for stem in stems:
        for candidate in sorted(directory.rglob("*.csv")):
            if candidate.stem.lower().replace(" ", "") == stem:
                return candidate
    return None


def _add_gravity_stream(trace: ImuTrace, gravity_path: Path, t0: float) -> ImuTrace:
    """Add a separately logged gravity stream onto a gravity-free one.

    The two streams share the export's clock but not its sample instants, so
    gravity is resampled onto the accelerometer's timestamps. It is a sub-1 Hz
    signal, so linear interpolation costs nothing.
    """
    gravity, _ = _trace_from_table(read_table(gravity_path), t0=t0)
    resampled = np.column_stack(
        [np.interp(trace.t, gravity.t, gravity.accel[:, i]) for i in range(3)]
    )
    return ImuTrace(t=trace.t, accel=trace.accel + resampled, fs=trace.fs)


def load_export_dir(directory: Path) -> Recording:
    """Load a Sensor Logger / phyphox style export directory.

    The stream picked is whichever total acceleration the export can supply,
    most-certain first: ``Accelerometer.csv`` + ``Gravity.csv`` reconstructs it
    exactly, ``TotalAcceleration.csv`` and ``AccelerometerUncalibrated.csv``
    already are it, and a bare accelerometer stream may be either — it is taken
    as-is and left to the quality gate. Whatever the route, the result is
    normalised to m/s² and the scale applied is recorded in the notes.
    """
    notes: list[str] = []
    plain = _find(directory, "accelerometer", "linearacceleration", "accelerationwithoutg")
    gravity_path = _find(directory, "gravity")
    total = _find(directory, "totalacceleration", "accelerometeruncalibrated")
    accel_path = plain if (plain is not None and gravity_path is not None) else (total or plain)
    if accel_path is None:
        raise FileNotFoundError(f"{directory}: no Accelerometer.csv / TotalAcceleration.csv found")
    cols = read_table(accel_path)
    trace, t0 = _trace_from_table(cols)
    if accel_path is plain and gravity_path is not None:
        trace = _add_gravity_stream(trace, gravity_path, t0)
        notes.append(
            f"total acceleration reconstructed from {accel_path.name} + {gravity_path.name}"
        )
    trace, _scale, scale_note = to_ms2(trace)
    notes.append(scale_note)
    gps_path = _find(directory, "location", "gps", "locationgps")
    gps = _gps_from_table(read_table(gps_path), t0) if gps_path else None
    if gps is None:
        notes.append("no GPS track: findings cannot be located along the route.")
    # Sensor Logger ships `seconds_elapsed` next to its epoch-ns `time`; phyphox
    # only has "Time (s)", which _normalize has already reduced to "time".
    fmt = "sensorlogger" if "seconds elapsed" in cols else "phyphox"
    return Recording(trace=trace, gps=gps, source=str(directory), format=fmt, notes=notes)


def load_generic_csv(accel_csv: Path, gps_csv: Path | None = None) -> Recording:
    """Load a single accelerometer CSV plus an optional GPS CSV."""
    trace, t0 = _trace_from_table(read_table(accel_csv))
    trace, _scale, scale_note = to_ms2(trace)
    notes: list[str] = [scale_note]
    gps = _gps_from_table(read_table(gps_csv), t0) if gps_csv else None
    if gps is None:
        notes.append("no GPS track: findings cannot be located along the route.")
    return Recording(trace=trace, gps=gps, source=str(accel_csv), format="csv", notes=notes)


def load_recording(path: Path, gps_csv: Path | None = None) -> Recording:
    """Auto-detect the input layout: directory, ``.zip`` export, or a CSV file."""
    path = Path(path)
    if path.is_dir():
        return load_export_dir(path)
    if path.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory(prefix="bridge-export-") as tmp_name:
            rec = load_export_dir(_extract_zip(path, Path(tmp_name)))
        return Recording(rec.trace, rec.gps, source=str(path), format=rec.format, notes=rec.notes)
    if not path.exists():
        raise FileNotFoundError(str(path))
    return load_generic_csv(path, gps_csv)


def _extract_zip(path: Path, dest: Path) -> Path:
    """Extract ``path`` under ``dest``, refusing traversal and oversized archives."""
    with zipfile.ZipFile(path) as zf:
        total = sum(info.file_size for info in zf.infolist())
        if total > MAX_ARCHIVE_BYTES:
            raise ValueError(
                f"{path}: unpacks to {total / 1e6:.0f} MB, over the "
                f"{MAX_ARCHIVE_BYTES / 1e6:.0f} MB limit"
            )
        root = dest.resolve()
        for info in zf.infolist():
            target = (root / info.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"{path}: entry {info.filename!r} escapes the extraction directory")
            zf.extract(info, root)
    return dest


def write_export_dir(directory: Path, trace: ImuTrace, gps: GpsTrack | None) -> Path:
    """Write a Sensor Logger shaped export (used by ``scan --demo`` and tests)."""
    directory.mkdir(parents=True, exist_ok=True)
    accel = directory / "TotalAcceleration.csv"
    with accel.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time", "seconds_elapsed", "z", "y", "x"])
        for ti, (ax, ay, az) in zip(trace.t, trace.accel, strict=True):
            w.writerow([DEMO_EPOCH_NS + int(ti * 1e9), f"{ti:.6f}", f"{az:.6f}", f"{ay:.6f}", f"{ax:.6f}"])
    if gps is not None:
        with (directory / "Location.csv").open("w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["time", "seconds_elapsed", "horizontalAccuracy", "longitude", "latitude"])
            acc = gps.accuracy_m if gps.accuracy_m is not None else np.full(gps.t.size, 3.0)
            for ti, la, lo, ac in zip(gps.t, gps.lat, gps.lon, acc, strict=True):
                w.writerow(
                    [DEMO_EPOCH_NS + int(ti * 1e9), f"{ti:.3f}", f"{ac:.2f}", f"{lo:.7f}", f"{la:.7f}"]
                )
    return accel
