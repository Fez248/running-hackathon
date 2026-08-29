"""End-to-end scan of one recorded pass: recording -> quality gate -> findings.

This is the MVP path for *floor imperfection* detection: point it at a phone
recording of a walk/run over a stretch of pavement and it answers three
questions in order — was the capture good enough to say anything, where along
the route does the surface deviate from the rest of the route, and what does
each deviation look like (something that rattles vs something that absorbs).

Findings carry lat/lon when GPS is present, so the output drops straight into
the Sidewalk Map data model (`ROUGH_SURFACE` reports) without another step.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from imukit.cadence import CadenceEstimate
from imukit.geo import accuracy_at_distance, position_at_distance

from .detect import detect_single_pass
from .ingest import Provenance, Recording
from .pipeline import ProcessedPass, process_pass
from .quality import MIN_FS_HZ, CaptureQuality, assess

# What the two detector polarities mean on a pavement, in the vocabulary of the
# Sidewalk Map report model (libs/core: ROUGH_SURFACE).
DIRECTION_LABELS = {
    "excess": ("loose_or_broken_element", "rattling/impact-heavy: loose slab, broken kerb, loose board"),
    "attenuation": ("compliant_or_absorbing", "soft/absorbing: mat, gravel, wet or deformable patch"),
}
CONFIDENCE_BY_VERDICT = {"ok": 1.0, "degraded": 0.6, "unusable": 0.0}

# Positional uncertainty when the track reports no accuracy at all. A phone in a
# city rarely does better than this, so it is the honest stand-in for "unknown"
# — quietly assuming a metre would turn an unknown into a claim.
DEFAULT_FIX_SIGMA_M = 10.0


@dataclass
class Finding:
    """One suspected floor imperfection along the route."""

    index: int
    kind: str
    description: str
    start_m: float
    end_m: float
    peak_m: float
    score: float
    confidence: float
    lat: float | None = None
    lon: float | None = None
    #: 1-sigma radius, in metres, within which the finding actually sits.
    uncertainty_m: float | None = None


@dataclass
class ScanResult:
    source: str
    format: str
    quality: CaptureQuality
    cadence_spm: float
    n_windows: int
    n_footfalls: int
    findings: list[Finding]
    notes: list[str] = field(default_factory=list)
    #: Evidence that the cadence is the step rate rather than the stride rate.
    cadence: CadenceEstimate | None = None
    provenance: Provenance = field(default_factory=Provenance)
    #: Robust-z threshold the detector ran at, part of what makes a finding arguable.
    threshold: float = 3.0

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "format": self.format,
            "quality": self.quality.as_dict(),
            "cadence_spm": self.cadence_spm,
            "n_windows": self.n_windows,
            "n_footfalls": self.n_footfalls,
            "findings": [asdict(f) for f in self.findings],
            "notes": self.notes,
            "cadence_check": None if self.cadence is None else self.cadence.as_dict(),
            "provenance": {**self.provenance.as_dict(), "detector_threshold": self.threshold},
        }


def scan_recording(rec: Recording, threshold: float = 3.0) -> tuple[ScanResult, ProcessedPass | None]:
    """Assess capture quality, run the single-pass detector, geo-locate findings."""
    threshold = float(threshold)
    if not np.isfinite(threshold) or threshold <= 0:
        raise ValueError(f"threshold must be a finite positive robust-z value, got {threshold!r}")
    quality = assess(rec)
    notes = list(rec.notes)
    if not quality.usable:
        notes.append("capture failed the quality gate; findings are withheld, fix the capture first")
        return (
            ScanResult(
                source=rec.source,
                format=rec.format,
                quality=quality,
                cadence_spm=0.0,
                n_windows=0,
                n_footfalls=0,
                findings=[],
                notes=notes,
                provenance=rec.provenance,
                threshold=threshold,
            ),
            None,
        )

    if quality.rate_limited:
        notes.append(
            f"sampled below {MIN_FS_HZ:.0f} Hz: reported findings are as reliable as a {MIN_FS_HZ:.0f} Hz "
            "pass's, but roughly half the defects are missed — an empty result is not evidence of a "
            "sound surface"
        )

    pp = process_pass(rec.trace, rec.gps)
    dets = detect_single_pass(pp, threshold=threshold)
    base_conf = CONFIDENCE_BY_VERDICT[quality.verdict]
    findings: list[Finding] = []
    for i, d in enumerate(dets):
        kind, description = DIRECTION_LABELS[d.direction]
        # A z of `threshold` is the weakest thing we report; saturate at 2x.
        strength = min(1.0, (abs(d.score) - threshold) / threshold + 0.5)
        lat = lon = uncertainty = None
        if rec.gps is not None and rec.gps.t.size >= 2:
            la, lo = position_at_distance(rec.gps, np.array([d.peak_m]))
            lat, lon = float(la[0]), float(lo[0])
            uncertainty = positional_uncertainty(rec, d.peak_m, d.end_m - d.start_m)
        findings.append(
            Finding(
                index=i,
                kind=kind,
                description=description,
                start_m=round(d.start_m, 1),
                end_m=round(d.end_m, 1),
                peak_m=round(d.peak_m, 1),
                score=round(float(d.score), 2),
                confidence=round(base_conf * strength, 2),
                lat=lat,
                lon=lon,
                uncertainty_m=None if uncertainty is None else round(uncertainty, 1),
            )
        )
    if not findings:
        notes.append(f"no window exceeded z={threshold}: either a uniform surface or too little contrast")
    return (
        ScanResult(
            source=rec.source,
            format=rec.format,
            quality=quality,
            cadence_spm=round(pp.f_step * 60.0, 1),
            n_windows=pp.n_windows,
            n_footfalls=int(pp.footfalls.size),
            findings=findings,
            notes=notes,
            cadence=pp.cadence,
            provenance=rec.provenance,
            threshold=threshold,
        ),
        pp,
    )


def positional_uncertainty(rec: Recording, peak_m: float, extent_m: float) -> float:
    """1-sigma radius, in metres, of where a finding really is.

    Two independent terms in quadrature: the GPS accuracy local to that point of
    the route, and the along-path extent of the detection itself — the detector
    says a stretch of pavement rattles, not a point, so half its extent is a
    real positional spread and not an error to be hidden. Stating +-5 m is
    useful; drawing the same finding as a pin is a lie.
    """
    sigma = np.nan
    if rec.gps is not None:
        sigma = float(accuracy_at_distance(rec.gps, np.array([float(peak_m)]))[0])
    if not np.isfinite(sigma):
        sigma = DEFAULT_FIX_SIGMA_M
    half_extent = max(0.0, float(extent_m)) / 2.0
    return float(np.hypot(sigma, half_extent))


def to_geojson(result: ScanResult) -> dict:
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [f.lon, f.lat]},
            "properties": {
                "kind": f.kind,
                "sidewalkMapKind": "ROUGH_SURFACE",
                "description": f.description,
                "distance_m": f.peak_m,
                "extent_m": [f.start_m, f.end_m],
                "score": f.score,
                "confidence": f.confidence,
                "uncertainty_m": f.uncertainty_m,
            },
        }
        for f in result.findings
        if f.lat is not None and f.lon is not None
    ]
    return {
        "type": "FeatureCollection",
        "features": features,
        "properties": {"source": result.source, "quality": result.quality.verdict},
    }


def source_label(source: str) -> str:
    """The recording's bare name, as the map records it."""
    return Path(source).name or source


def default_client_scan_id(result: ScanResult) -> str:
    """Content-addressed id for a scan.

    The ingest endpoint deduplicates on this id, so it is derived from what the
    scan actually says rather than from how it was produced: two runs that make
    the same claim about the same route are the same scan, whatever settings
    they used or wherever the recording sat on disk, and any run whose findings
    or certificate differ hashes differently. Pass ``--client-scan-id`` to key a
    scan on something else.
    """
    claim = dict(result.as_dict())
    claim["source"] = source_label(result.source)
    material = json.dumps(claim, sort_keys=True, default=str)
    return "scan-" + hashlib.sha256(material.encode()).hexdigest()[:24]


def to_map_payload(result: ScanResult, client_scan_id: str | None = None) -> dict:
    """The payload accepted by the Sidewalk Map ``scan.ingest`` endpoint.

    Same content as :meth:`ScanResult.as_dict`, in the map's naming conventions:
    camelCase keys and ``lng`` instead of ``lon``. Findings the GPS could not
    place are omitted — a surface report without a position cannot go on a map —
    but the quality certificate is sent whatever the verdict, so the server can
    record (and refuse) an unusable capture rather than never hearing about it.

    The recording is named, not located: ``source`` is reduced to a bare name so
    an upload does not publish the home directory it was scanned from.
    """
    q = result.quality
    p = result.provenance
    return {
        "source": source_label(result.source),
        "format": result.format,
        "quality": {
            "fsHz": q.fs_hz,
            "jitterMs": q.jitter_ms,
            "dropoutFrac": q.dropout_frac,
            "durationS": q.duration_s,
            "gravityPresent": q.gravity_present,
            "clippingFrac": q.clipping_frac,
            "gpsPresent": q.gps_present,
            "gpsAccuracyM": q.gps_accuracy_m,
            "routeLengthM": q.route_length_m,
            "verdict": q.verdict,
            "problems": list(q.problems),
            "warnings": list(q.warnings),
        },
        "cadenceSpm": result.cadence_spm,
        "provenance": {
            "recorderApp": p.recorder_app,
            "recorderVersion": p.recorder_version,
            "deviceModel": p.device_model,
            "platform": p.platform,
            "requestedFsHz": p.requested_fs_hz,
            "measuredFsHz": p.measured_fs_hz,
            "unitScale": p.unit_scale,
            "detectorThreshold": result.threshold,
        },
        "findings": [
            {
                "index": f.index,
                "kind": f.kind,
                "description": f.description,
                "startM": f.start_m,
                "endM": f.end_m,
                "peakM": f.peak_m,
                "score": f.score,
                "confidence": f.confidence,
                "lat": f.lat,
                "lng": f.lon,
                "uncertaintyM": f.uncertainty_m,
            }
            for f in result.findings
            if f.lat is not None and f.lon is not None
        ],
        "clientScanId": client_scan_id or default_client_scan_id(result),
    }


def to_csv(result: ScanResult) -> str:
    header = "index,kind,start_m,end_m,peak_m,score,confidence,lat,lon,uncertainty_m"
    rows = [
        f"{f.index},{f.kind},{f.start_m},{f.end_m},{f.peak_m},{f.score},{f.confidence},"
        f"{'' if f.lat is None else f'{f.lat:.7f}'},{'' if f.lon is None else f'{f.lon:.7f}'},"
        f"{'' if f.uncertainty_m is None else f'{f.uncertainty_m:.1f}'}"
        for f in result.findings
    ]
    return "\n".join([header, *rows]) + "\n"


def write_output(result: ScanResult, path: Path, fmt: str, client_scan_id: str | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "json":
        path.write_text(json.dumps(result.as_dict(), indent=2, default=str))
    elif fmt == "geojson":
        path.write_text(json.dumps(to_geojson(result), indent=2))
    elif fmt == "map":
        path.write_text(json.dumps(to_map_payload(result, client_scan_id), indent=2, default=str))
    elif fmt == "csv":
        path.write_text(to_csv(result))
    else:
        raise ValueError(f"unknown output format {fmt!r}")
    return path


def _cadence_lines(cadence: CadenceEstimate | None) -> list[str]:
    """The cadence cross-check, so a halved cadence is visible instead of implicit."""
    if cadence is None:
        return []
    checks = [f"decided by {cadence.basis}"]
    if cadence.step_length_m is not None and cadence.speed_mps is not None:
        checks.append(f"{cadence.step_length_m:.2f} m per step at {cadence.speed_mps:.2f} m/s")
    if cadence.f_footfall is not None:
        checks.append(f"footfall intervals {cadence.f_footfall * 60:.0f} spm")
    if cadence.asymmetry is not None:
        checks.append(f"L/R asymmetry {cadence.asymmetry:.0%}")
    lines = [f"cadence check {', '.join(checks)}"]
    if cadence.corrected:
        lines.append(
            f"  ~ spectral fundamental was {cadence.f_spectral * 60:.0f} spm (the stride); "
            f"doubled to {cadence.spm:.0f} spm"
        )
    lines += [f"  ~ {note}" for note in cadence.notes if not cadence.corrected]
    return lines


def format_report(result: ScanResult) -> str:
    """Human-readable summary printed by ``bridge scan``."""
    q = result.quality
    lines = [
        f"source        {result.source}  ({result.format})",
        f"capture       {q.fs_hz:.0f} Hz IMU, {q.duration_s:.0f} s, jitter p95 {q.jitter_ms:.1f} ms"
        + (
            (f", GPS {q.gps_rate_hz:.1f} Hz" if q.gps_rate_hz is not None else ", GPS rate unknown")
            + (f" @ {q.gps_accuracy_m:.1f} m" if q.gps_accuracy_m is not None else "")
            + (f", route {q.route_length_m:.0f} m" if q.route_length_m is not None else "")
            if q.gps_present
            else ", no GPS"
        ),
        f"verdict       {q.verdict.upper()}",
    ]
    lines += [f"  ! {p}" for p in q.problems]
    lines += [f"  ~ {w}" for w in q.warnings]
    if q.usable:
        lines.append(
            f"gait          {result.cadence_spm:.0f} spm, "
            f"{result.n_footfalls} footfalls, {result.n_windows} windows"
        )
        lines += _cadence_lines(result.cadence)
        lines.append(f"findings      {len(result.findings)}")
        for f in result.findings:
            where = f" @ {f.lat:.6f},{f.lon:.6f}" if f.lat is not None else ""
            if f.uncertainty_m is not None:
                where += f" \u00b1{f.uncertainty_m:.0f} m"
            lines.append(
                f"  #{f.index} {f.kind:26s} {f.start_m:7.1f}-{f.end_m:7.1f} m "
                f"peak {f.peak_m:7.1f} m  z={f.score:5.2f}  conf={f.confidence:.2f}{where}"
            )
    lines += [f"  note: {n}" for n in result.notes]
    return "\n".join(lines)
