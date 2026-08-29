"""Ingest, quality gate and scan: the real-recording path."""

from __future__ import annotations

import numpy as np
import pytest
from imukit.geo import cumulative_distance, position_at_distance

from bridge.experiments import ROUTE_ANOMALIES
from bridge.ingest import load_recording, write_export_dir
from bridge.quality import FLOOR_FS_HZ, assess
from bridge.scan import CONFIDENCE_BY_VERDICT, format_report, scan_recording, to_csv, to_geojson
from bridge.synth import SurfaceScenario, simulate_pass

SENSORLOGGER_ACCEL = """time,seconds_elapsed,z,y,x
1700000000000000000,0.000000,9.800000,0.100000,0.200000
1700000000005000000,0.005000,9.810000,0.110000,0.210000
1700000000010000000,0.010000,9.790000,0.090000,0.190000
"""
PHYPHOX_ACCEL = '''"Time (s)";"Acceleration x (m/s^2)";"Acceleration y (m/s^2)";"Acceleration z (m/s^2)"
0.000000;0.200000;0.100000;9.800000
0.005000;0.210000;0.110000;9.810000
0.010000;0.190000;0.090000;9.790000
'''
PHYPHOX_LOCATION = '''"Time (s)";"Latitude (°)";"Longitude (°)";"Horizontal Accuracy (m)"
0.000000;51.500000;-0.124000;3.0
5.000000;51.500100;-0.124000;3.2
'''


def _short_pass(**overrides):
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES), **overrides)
    trace, gps, truth = simulate_pass(scn)
    return trace, gps, truth


def test_sensorlogger_export_round_trip(tmp_path):
    trace, gps, _ = _short_pass(length_m=120.0)
    write_export_dir(tmp_path / "rec", trace, gps)
    rec = load_recording(tmp_path / "rec")

    assert rec.format == "sensorlogger"
    assert rec.gps is not None
    assert rec.trace.fs == pytest.approx(200.0, rel=1e-3)
    assert len(rec.trace) == len(trace)
    # Timestamps are written as epoch ns and must come back as relative seconds.
    assert rec.trace.t[0] == pytest.approx(0.0, abs=1e-6)
    assert np.allclose(rec.trace.accel, trace.accel, atol=1e-5)
    assert np.allclose(rec.gps.lat, gps.lat, atol=1e-6)


def test_zip_export_is_read_like_a_directory(tmp_path):
    import zipfile

    trace, gps, _ = _short_pass(length_m=90.0)
    src = tmp_path / "rec"
    write_export_dir(src, trace, gps)
    archive = tmp_path / "rec.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(src.iterdir()):
            zf.write(f, f.name)

    rec = load_recording(archive)
    assert len(rec.trace) == len(trace)
    assert rec.gps is not None


def test_sensorlogger_and_phyphox_headers_parse(tmp_path):
    sl = tmp_path / "sl"
    sl.mkdir()
    (sl / "TotalAcceleration.csv").write_text(SENSORLOGGER_ACCEL)
    px = tmp_path / "px"
    px.mkdir()
    (px / "Accelerometer.csv").write_text(PHYPHOX_ACCEL)
    (px / "Location.csv").write_text(PHYPHOX_LOCATION)

    a = load_recording(sl)
    b = load_recording(px)
    # Same three samples, whatever the header wording, delimiter or axis order.
    assert np.allclose(a.trace.accel, b.trace.accel)
    assert a.trace.t[-1] == pytest.approx(0.01)
    assert b.gps is not None and b.gps.accuracy_m is not None
    assert a.gps is None and any("no GPS" in n for n in a.notes)


def test_generic_csv_with_separate_gps(tmp_path):
    accel = tmp_path / "accel.csv"
    accel.write_text("t,ax,ay,az\n0.0,0.1,0.2,9.8\n0.01,0.1,0.2,9.8\n")
    gps = tmp_path / "gps.csv"
    gps.write_text("t,lat,lon,accuracy_m\n0.0,51.5,-0.124,4.0\n1.0,51.5001,-0.124,4.0\n")

    rec = load_recording(accel, gps)
    assert rec.format == "csv"
    assert rec.gps is not None
    assert rec.gps.accuracy_m[0] == pytest.approx(4.0)


def test_gravity_free_stream_is_rejected_by_the_quality_gate(tmp_path):
    d = tmp_path / "linear"
    d.mkdir()
    rows = "\n".join(f"{i * 0.005:.3f},0.1,0.2,0.3" for i in range(40_000))
    (d / "LinearAcceleration.csv").write_text("seconds_elapsed,x,y,z\n" + rows + "\n")

    q = assess(load_recording(d))
    assert not q.gravity_present
    assert q.verdict == "unusable"
    assert any("gravity" in p for p in q.problems)


def test_low_sample_rate_and_bad_gps_fail_the_gate(tmp_path):
    trace, gps, _ = _short_pass(fs=50.0, gps_noise_m=8.0)
    gps.accuracy_m = np.full(gps.t.size, 8.0)
    write_export_dir(tmp_path / "rec", trace, gps)

    result, pp = scan_recording(load_recording(tmp_path / "rec"))
    assert pp is None
    assert result.findings == []
    assert result.quality.verdict == "unusable"
    assert any("GPS accuracy" in p for p in result.quality.problems)
    # 50 Hz on its own no longer withholds anything, it only downgrades.
    assert any("shock band" in w for w in result.quality.warnings)


def test_sub_100hz_capture_is_degraded_but_still_reports_findings(tmp_path):
    trace, gps, _ = _short_pass(fs=60.0)
    write_export_dir(tmp_path / "rec", trace, gps)

    result, pp = scan_recording(load_recording(tmp_path / "rec"))
    assert pp is not None
    assert result.quality.verdict == "degraded"
    assert result.quality.rate_limited
    assert result.quality.problems == []
    assert result.findings, "a 60 Hz capture still carries usable evidence"
    assert all(f.confidence <= CONFIDENCE_BY_VERDICT["degraded"] for f in result.findings)
    assert any("shock band" in w for w in result.quality.warnings)
    assert any("not evidence of a sound surface" in n for n in result.notes)


@pytest.mark.parametrize("fs", [35.0, FLOOR_FS_HZ])
def test_sample_rate_at_or_below_the_nyquist_floor_is_unusable(tmp_path, fs):
    trace, gps, _ = _short_pass(fs=fs)
    write_export_dir(tmp_path / "rec", trace, gps)

    result, pp = scan_recording(load_recording(tmp_path / "rec"))
    assert pp is None
    assert result.findings == []
    assert result.quality.verdict == "unusable"
    assert not result.quality.rate_limited
    assert result.quality.shock_band_covered_frac == 0.0
    assert any("Nyquist" in p for p in result.quality.problems)


def test_just_above_the_floor_is_graded_not_refused(tmp_path):
    """The floor is the Nyquist condition, not a round number: 41 Hz still sees
    the bottom of the shock band and E6 scores it as precisely as 100 Hz."""
    trace, gps, _ = _short_pass(fs=FLOOR_FS_HZ + 1.0)
    write_export_dir(tmp_path / "rec", trace, gps)

    q = assess(load_recording(tmp_path / "rec"))
    assert q.verdict == "degraded"
    assert q.rate_limited
    assert 0.0 < q.shock_band_covered_frac < 0.1


def test_full_rate_capture_keeps_the_unqualified_verdict(tmp_path):
    trace, gps, _ = _short_pass(fs=200.0)
    write_export_dir(tmp_path / "rec", trace, gps)

    q = assess(load_recording(tmp_path / "rec"))
    assert q.verdict == "ok"
    assert not q.rate_limited
    assert q.shock_band_covered_frac == 1.0


def test_scan_of_a_good_recording_finds_and_locates_anomalies(tmp_path):
    trace, gps, truth = _short_pass()
    write_export_dir(tmp_path / "rec", trace, gps)

    result, _pp = scan_recording(load_recording(tmp_path / "rec"))
    assert result.quality.verdict == "ok"
    assert result.cadence_spm > 100
    assert result.findings, "expected at least one finding on the seeded anomalous route"

    slab = min(result.findings, key=lambda f: abs(f.peak_m - 84.0))
    assert abs(slab.peak_m - 84.0) < 15.0
    assert slab.kind == "loose_or_broken_element"
    assert slab.lat is not None and slab.lon is not None
    # Every finding must sit on the recorded track, not somewhere off-route.
    assert min(abs(gps.lat - slab.lat)) < 1e-3

    gj = to_geojson(result)
    assert len(gj["features"]) == len(result.findings)
    assert gj["features"][0]["properties"]["sidewalkMapKind"] == "ROUGH_SURFACE"
    assert to_csv(result).count("\n") == len(result.findings) + 1


def test_vigorous_gravity_free_stream_still_fails_the_gate(tmp_path):
    # Running-scale linear acceleration: mean |a| is well above 0.5 g even though
    # gravity is gone, which is exactly what a mean-magnitude test would miss.
    trace, gps, _ = _short_pass(length_m=200.0)
    trace.accel = 3.0 * (trace.accel - np.mean(trace.accel, axis=0))
    assert np.mean(np.linalg.norm(trace.accel, axis=1)) > 0.5 * 9.80665
    write_export_dir(tmp_path / "rec", trace, gps)

    q = assess(load_recording(tmp_path / "rec"))
    assert not q.gravity_present
    assert q.verdict == "unusable"


def test_gps_free_recording_is_rejected_rather_than_located_at_zero(tmp_path):
    trace, _gps, _ = _short_pass(length_m=200.0)
    write_export_dir(tmp_path / "rec", trace, None)

    result, pp = scan_recording(load_recording(tmp_path / "rec"))
    assert pp is None
    assert result.findings == []
    assert any("GPS" in p for p in result.quality.problems)


def test_nonpositive_threshold_is_rejected(tmp_path):
    trace, gps, _ = _short_pass(length_m=120.0)
    write_export_dir(tmp_path / "rec", trace, gps)
    rec = load_recording(tmp_path / "rec")

    for bad in (0.0, -1.0, float("nan"), float("inf")):
        with pytest.raises(ValueError):
            scan_recording(rec, threshold=bad)


def test_zip_entries_cannot_escape_the_extraction_directory(tmp_path):
    import zipfile

    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../pwned.csv", "seconds_elapsed,x,y,z\n0.0,0.1,0.2,9.8\n")

    with pytest.raises(ValueError, match="escapes"):
        load_recording(archive)
    assert not (tmp_path / "pwned.csv").exists()


def test_position_at_distance_inverts_cumulative_distance():
    _trace, gps, _ = _short_pass(length_m=200.0, gps_noise_m=0.0)
    d = cumulative_distance(gps, smooth_s=5.0)
    lat, lon = position_at_distance(gps, np.array([d[10], d[40]]))
    assert lat[0] == pytest.approx(gps.lat[10], abs=1e-4)
    assert lon[1] == pytest.approx(gps.lon[40], abs=1e-4)


def test_blank_accuracy_column_keeps_the_gps_track(tmp_path):
    trace, gps, _ = _short_pass(length_m=120.0)
    write_export_dir(tmp_path / "rec", trace, gps)
    location = tmp_path / "rec" / "Location.csv"
    rows = location.read_text().splitlines()
    header, body = rows[0], rows[1:]
    blanked = [",".join(c if i != 2 else "" for i, c in enumerate(r.split(","))) for r in body]
    location.write_text("\n".join([header, *blanked]) + "\n")

    rec = load_recording(tmp_path / "rec")
    assert rec.gps is not None
    assert rec.gps.t.size == gps.t.size
    assert rec.gps.accuracy_m is None
    assert assess(rec).usable


def test_non_increasing_gps_timestamps_are_rejected(tmp_path):
    trace, gps, _ = _short_pass(length_m=120.0)
    write_export_dir(tmp_path / "rec", trace, gps)
    location = tmp_path / "rec" / "Location.csv"
    rows = location.read_text().splitlines()
    header, body = rows[0], rows[1:]
    frozen = [",".join([body[0].split(",")[0], body[0].split(",")[1], *r.split(",")[2:]]) for r in body]
    location.write_text("\n".join([header, *frozen]) + "\n")

    rec = load_recording(tmp_path / "rec")
    result, pp = scan_recording(rec)
    assert pp is None
    assert not result.quality.usable
    assert any("GPS timestamps" in p for p in result.quality.problems)
    assert "GPS rate unknown" in format_report(result)
