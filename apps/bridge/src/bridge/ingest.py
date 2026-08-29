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

Two things a real export gets wrong and this module has to repair:

**Units.** Sensor Logger reports ``AccelerometerUncalibrated.csv`` in *g*, not
m/s^2, while ``TotalAcceleration.csv`` is m/s^2. Both carry gravity, so the DC
magnitude of the stream identifies which unit it is in (~1 vs ~9.8) and
:func:`_rescale_to_ms2` normalises it. Without that a perfectly good recording
looks like a gravity-free linear-acceleration stream to the quality gate.

**Gravity.** iOS ``Accelerometer.csv`` *is* user acceleration: gravity is
already removed, which makes the vertical projection impossible. When the export
also holds ``Gravity.csv`` the total is reconstructed by summing the two streams
(:func:`_reconstruct_total`), which is what a hand repair did before.
"""

from __future__ import annotations

import csv
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from imukit.preprocess import G, dc_magnitude, dc_steadiness
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

# Accepted DC-magnitude bands for a gravity-carrying stream, per unit. They do
# not overlap (2 g vs 4.9 m/s^2), so the measured DC picks the unit outright;
# anything below the g band has no gravity in it at all and is left untouched
# for the quality gate to reject.
GRAVITY_DC_BAND_G = (0.5, 2.0)
GRAVITY_DC_BAND_MS2 = (0.5 * G, 2.0 * G)

# Magnitude alone cannot tell a 1 g stream from a gravity-free m/s^2 stream whose
# drift happens to sit near 1: both read "1". Gravity is a constant, so the
# low-passed norm of a stream carrying it is flat (measured ~0.06 IQR/median on
# a running pass) where drift wanders (~0.75). Only a steady DC is treated as g
# and multiplied, so a linear-acceleration stream is never inflated into looking
# like a usable capture.
MAX_GRAVITY_DC_IQR = 0.25

# Sensor Logger writes one metadata row per export; these are the column names
# it has used for the fields worth keeping, lower-cased by `_normalize`.
META_KEYS = {
    "recorder_app": ("appname", "app name", "app"),
    "recorder_version": ("appversion", "app version", "version"),
    "device_model": ("device model", "devicemodel", "model", "device name", "devicename", "device"),
    "platform": ("platform", "os", "device platform"),
    "sensors": ("sensors", "enabled sensors", "sensor list"),
    "sample_rate_ms": ("sampleratems", "sample rate ms", "sampling rate ms", "sample interval ms"),
    "sample_rate_hz": ("sampleratehz", "sample rate hz", "sampling rate hz", "samplerate"),
}


@dataclass
class Provenance:
    """How the recording was made — the settings a finding must be traceable to.

    A finding that cannot be traced to the capture settings that produced it
    cannot be argued with, so this travels with the scan all the way into the
    map rather than living only in the shell history of whoever ran the CLI.
    """

    recorder_app: str | None = None
    recorder_version: str | None = None
    device_model: str | None = None
    platform: str | None = None
    #: Rate asked of the recorder app, from the export metadata.
    requested_fs_hz: float | None = None
    #: Rate the export actually delivered (median sample interval).
    measured_fs_hz: float | None = None
    #: Factor applied to the accelerometer stream to reach m/s^2 (1.0, or g for a g-unit stream).
    unit_scale: float = 1.0
    #: Streams the recorder was asked to log; a long list is why a rate is missed.
    sensors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Recording:
    """One recorded pass: IMU (+ GPS) plus provenance and caveats."""

    trace: ImuTrace
    gps: GpsTrack | None
    source: str
    format: str
    notes: list[str] = field(default_factory=list)
    provenance: Provenance = field(default_factory=Provenance)


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


def _read_metadata(directory: Path) -> dict[str, str]:
    """Read a recorder's one-row ``Metadata.csv`` into ``{normalized: value}``.

    Kept separate from :func:`read_table` because every field here is a string:
    an app version and a sensor list do not survive being parsed as floats.
    """
    path = _find(directory, "metadata")
    if path is None:
        return {}
    lines = [ln for ln in path.read_text(encoding="utf-8-sig", errors="replace").splitlines() if ln.strip()]
    if len(lines) < 2:
        return {}
    try:
        delim = csv.Sniffer().sniff(lines[0], delimiters=",;\t").delimiter
    except csv.Error:
        delim = ","
    rows = list(csv.reader(lines, delimiter=delim))
    header = [_normalize(h) for h in rows[0]]
    return {h: cell.strip() for h, cell in zip(header, rows[1], strict=False) if h and cell.strip()}


def _meta_value(meta: dict[str, str], keys: tuple[str, ...]) -> str | None:
    for k in keys:
        if meta.get(k):
            return meta[k]
    return None


def _requested_fs(meta: dict[str, str]) -> float | None:
    """Requested sample rate in Hz, from whichever unit the export states it in.

    Sensor Logger asks for a sample *interval* in milliseconds, so "5 ms" in the
    metadata is the 200 Hz the recording was supposed to deliver.
    """
    for keys, to_hz in (
        (META_KEYS["sample_rate_hz"], lambda v: v),
        (META_KEYS["sample_rate_ms"], lambda v: 1e3 / v),
    ):
        text = _meta_value(meta, keys)
        if not text:
            continue
        try:
            value = float(text)
        except ValueError:
            continue
        if value > 0:
            return to_hz(value)
    return None


def _rescale_to_ms2(trace: ImuTrace) -> tuple[ImuTrace, float, float]:
    """Normalise a gravity-carrying accelerometer stream to m/s^2.

    Returns the trace, the factor applied, and the DC magnitude in m/s^2. A
    stream whose DC sits in the g band *and* holds steady there is in g and is
    scaled; anything else is handed on untouched, so a genuinely gravity-free
    stream still reaches the quality gate as the unusable capture it is instead
    of being multiplied into looking like one.
    """
    dc = dc_magnitude(trace.accel, trace.fs)
    lo, hi = GRAVITY_DC_BAND_G
    if lo <= dc <= hi and dc_steadiness(trace.accel, trace.fs) <= MAX_GRAVITY_DC_IQR:
        scaled = ImuTrace(t=trace.t, accel=trace.accel * G, fs=trace.fs, meta=dict(trace.meta))
        return scaled, G, dc * G
    return trace, 1.0, dc


def _reconstruct_total(directory: Path, trace: ImuTrace, t0: float) -> ImuTrace | None:
    """Rebuild total acceleration as user acceleration + gravity.

    iOS ``Accelerometer.csv`` has gravity removed. Sensor Logger logs gravity as
    its own stream on its own clock, so it is interpolated onto the
    accelerometer timestamps before the sum.
    """
    gravity_path = _find(directory, "gravity")
    if gravity_path is None:
        return None
    gravity, _g0 = _trace_from_table(read_table(gravity_path), t0=t0)
    gravity, _scale, dc = _rescale_to_ms2(gravity)
    if not GRAVITY_DC_BAND_MS2[0] <= dc <= GRAVITY_DC_BAND_MS2[1]:
        return None
    grav = np.column_stack(
        [np.interp(trace.t, gravity.t, gravity.accel[:, i]) for i in range(3)]
    )
    return ImuTrace(t=trace.t, accel=trace.accel + grav, fs=trace.fs, meta=dict(trace.meta))


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
    trace, scale, dc = _rescale_to_ms2(trace)
    if scale != 1.0:
        notes.append(
            f"{accel_path.name} is in g (DC |a| = {dc / G:.2f} g); scaled by {G:.5f} to m/s^2"
        )
    if dc < GRAVITY_DC_BAND_MS2[0]:
        rebuilt = _reconstruct_total(directory, trace, t0)
        if rebuilt is not None:
            trace, scale, dc = _rescale_to_ms2(rebuilt)
            notes.append(
                f"{accel_path.name} carries no gravity; total acceleration reconstructed as "
                "accelerometer + Gravity.csv"
            )
    gps_path = _find(directory, "location", "gps", "locationgps")
    gps = _gps_from_table(read_table(gps_path), t0) if gps_path else None
    if gps is None:
        notes.append("no GPS track: findings cannot be located along the route.")
    # Sensor Logger ships `seconds_elapsed` next to its epoch-ns `time`; phyphox
    # only has "Time (s)", which _normalize has already reduced to "time".
    fmt = "sensorlogger" if "seconds elapsed" in cols else "phyphox"
    meta = _read_metadata(directory)
    provenance = Provenance(
        recorder_app=_meta_value(meta, META_KEYS["recorder_app"])
        or ("Sensor Logger" if fmt == "sensorlogger" else None),
        recorder_version=_meta_value(meta, META_KEYS["recorder_version"]),
        device_model=_meta_value(meta, META_KEYS["device_model"]),
        platform=_meta_value(meta, META_KEYS["platform"]),
        requested_fs_hz=_requested_fs(meta),
        measured_fs_hz=trace.fs,
        unit_scale=scale,
        sensors=_sensor_list(meta, directory),
    )
    return Recording(
        trace=trace,
        gps=gps,
        source=str(directory),
        format=fmt,
        notes=notes,
        provenance=provenance,
    )


def _sensor_list(meta: dict[str, str], directory: Path) -> list[str]:
    """Streams the recording holds, from the metadata or the files themselves.

    The file listing is the fallback because the sensor count is what explains a
    missed sample rate, and an export that omits the metadata column still shows
    one CSV per enabled sensor.
    """
    stated = _meta_value(meta, META_KEYS["sensors"])
    if stated:
        return [s.strip() for s in stated.replace(";", ",").replace("|", ",").split(",") if s.strip()]
    skip = {"metadata", "annotation"}
    return sorted(
        {p.stem for p in directory.rglob("*.csv") if p.stem.lower().replace(" ", "") not in skip}
    )


def load_generic_csv(accel_csv: Path, gps_csv: Path | None = None) -> Recording:
    """Load a single accelerometer CSV plus an optional GPS CSV."""
    trace, t0 = _trace_from_table(read_table(accel_csv))
    notes: list[str] = []
    trace, scale, dc = _rescale_to_ms2(trace)
    if scale != 1.0:
        notes.append(
            f"{accel_csv.name} is in g (DC |a| = {dc / G:.2f} g); scaled by {G:.5f} to m/s^2"
        )
    gps = _gps_from_table(read_table(gps_csv), t0) if gps_csv else None
    if gps is None:
        notes.append("no GPS track: findings cannot be located along the route.")
    return Recording(
        trace=trace,
        gps=gps,
        source=str(accel_csv),
        format="csv",
        notes=notes,
        provenance=Provenance(measured_fs_hz=trace.fs, unit_scale=scale),
    )


def load_recording(path: Path, gps_csv: Path | None = None) -> Recording:
    """Auto-detect the input layout: directory, ``.zip`` export, or a CSV file."""
    path = Path(path)
    if path.is_dir():
        return load_export_dir(path)
    if path.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory(prefix="bridge-export-") as tmp_name:
            rec = load_export_dir(_extract_zip(path, Path(tmp_name)))
        return Recording(
            rec.trace,
            rec.gps,
            source=str(path),
            format=rec.format,
            notes=rec.notes,
            provenance=rec.provenance,
        )
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
