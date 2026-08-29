"""Load *real* phone recordings into ``ImuTrace`` / ``GpsTrack``.

Everything else in this app runs on the synthetic forward model. This module is
the missing half: it takes what an off-the-shelf logging app on a phone actually
exports and hands the pipeline the same containers the simulator produces, so a
recorded pass and a simulated pass go through exactly the same code path.

Supported inputs (auto-detected):

* **Sensor Logger** (iOS/Android) export directory or ``.zip`` —
  ``TotalAcceleration.csv`` (preferred) or ``Accelerometer.csv`` plus
  ``Location.csv``;
* **phyphox** export directory or ``.zip`` — ``Accelerometer.csv`` /
  ``Location.csv`` with ``"Time (s)"``-style headers, comma or semicolon
  separated;
* **generic CSV** — a time column plus three acceleration columns, with an
  optional separate GPS CSV (``t,lat,lon[,accuracy_m]``).

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


def _gps_from_table(cols: dict[str, np.ndarray], t0: float) -> GpsTrack | None:
    t_raw, lat, lon = _pick(cols, TIME_KEYS), _pick(cols, LAT_KEYS), _pick(cols, LON_KEYS)
    if t_raw is None or lat is None or lon is None:
        return None
    acc = _pick(cols, ACC_KEYS)
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


def load_export_dir(directory: Path) -> Recording:
    """Load a Sensor Logger / phyphox style export directory."""
    total = _find(directory, "totalacceleration", "accelerometeruncalibrated")
    plain = _find(directory, "accelerometer", "linearacceleration", "accelerationwithoutg")
    accel_path = total or plain
    if accel_path is None:
        raise FileNotFoundError(f"{directory}: no Accelerometer.csv / TotalAcceleration.csv found")
    cols = read_table(accel_path)
    notes: list[str] = []
    trace, t0 = _trace_from_table(cols)
    gps_path = _find(directory, "location", "gps", "locationgps")
    gps = _gps_from_table(read_table(gps_path), t0) if gps_path else None
    if gps is None:
        notes.append("no GPS track: detections are reported in seconds, not metres along the route.")
    # phyphox headers are "Time (s)"; Sensor Logger ships an epoch-ns `time`.
    fmt = "phyphox" if "time s" in cols else "sensorlogger"
    return Recording(trace=trace, gps=gps, source=str(directory), format=fmt, notes=notes)


def load_generic_csv(accel_csv: Path, gps_csv: Path | None = None) -> Recording:
    """Load a single accelerometer CSV plus an optional GPS CSV."""
    trace, t0 = _trace_from_table(read_table(accel_csv))
    notes: list[str] = []
    gps = _gps_from_table(read_table(gps_csv), t0) if gps_csv else None
    if gps is None:
        notes.append("no GPS track: detections are reported in seconds, not metres along the route.")
    return Recording(trace=trace, gps=gps, source=str(accel_csv), format="csv", notes=notes)


def load_recording(path: Path, gps_csv: Path | None = None) -> Recording:
    """Auto-detect the input layout: directory, ``.zip`` export, or a CSV file."""
    path = Path(path)
    if path.is_dir():
        return load_export_dir(path)
    if path.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="bridge-export-"))
        with zipfile.ZipFile(path) as zf:
            zf.extractall(tmp)
        rec = load_export_dir(tmp)
        return Recording(rec.trace, rec.gps, source=str(path), format=rec.format, notes=rec.notes)
    if not path.exists():
        raise FileNotFoundError(str(path))
    return load_generic_csv(path, gps_csv)


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
