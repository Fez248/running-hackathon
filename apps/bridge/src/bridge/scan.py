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
from imukit.geo import position_at_distance

from .detect import detect_single_pass
from .ingest import Recording
from .pipeline import ProcessedPass, process_pass
from .quality import MIN_FS_HZ, CaptureQuality, assess

# What the two detector polarities mean on a pavement, in the vocabulary of the
# Sidewalk Map report model (libs/core: ROUGH_SURFACE).
DIRECTION_LABELS = {
    "excess": ("loose_or_broken_element", "rattling/impact-heavy: loose slab, broken kerb, loose board"),
    "attenuation": ("compliant_or_absorbing", "soft/absorbing: mat, gravel, wet or deformable patch"),
}
CONFIDENCE_BY_VERDICT = {"ok": 1.0, "degraded": 0.6, "unusable": 0.0}


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
        lat = lon = None
        if rec.gps is not None and rec.gps.t.size >= 2:
            la, lo = position_at_distance(rec.gps, np.array([d.peak_m]))
            lat, lon = float(la[0]), float(lo[0])
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
        ),
        pp,
    )


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


def default_client_scan_id(result: ScanResult) -> str:
    """Content-addressed id for a scan.

    The ingest endpoint deduplicates on this id, so it is derived from what the
    scan actually says rather than from how it was produced: two runs that make
    the same claim about the same route are the same scan, whatever settings
    they used, and any run whose findings or certificate differ hashes
    differently. Pass ``--client-scan-id`` to key a scan on something else.
    """
    material = json.dumps(result.as_dict(), sort_keys=True, default=str)
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
    return {
        "source": Path(result.source).name or result.source,
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
            }
            for f in result.findings
            if f.lat is not None and f.lon is not None
        ],
        "clientScanId": client_scan_id or default_client_scan_id(result),
    }


def to_csv(result: ScanResult) -> str:
    header = "index,kind,start_m,end_m,peak_m,score,confidence,lat,lon"
    rows = [
        f"{f.index},{f.kind},{f.start_m},{f.end_m},{f.peak_m},{f.score},{f.confidence},"
        f"{'' if f.lat is None else f'{f.lat:.7f}'},{'' if f.lon is None else f'{f.lon:.7f}'}"
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
        lines.append(f"findings      {len(result.findings)}")
        for f in result.findings:
            where = f" @ {f.lat:.6f},{f.lon:.6f}" if f.lat is not None else ""
            lines.append(
                f"  #{f.index} {f.kind:26s} {f.start_m:7.1f}-{f.end_m:7.1f} m "
                f"peak {f.peak_m:7.1f} m  z={f.score:5.2f}  conf={f.confidence:.2f}{where}"
            )
    lines += [f"  note: {n}" for n in result.notes]
    return "\n".join(lines)
