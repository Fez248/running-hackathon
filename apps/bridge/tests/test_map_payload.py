"""The bridge -> Sidewalk Map seam: `--format map` payload shape and idempotency.

The map validates this payload with `scanIngestSchema` (libs/core/src/scan.ts);
these tests pin the contract on the Python side so a rename here fails loudly
instead of at upload time.
"""

from __future__ import annotations

import json
from dataclasses import replace

import numpy as np
import pytest

from bridge.cli import main
from bridge.experiments import ROUTE_ANOMALIES
from bridge.ingest import load_recording, write_export_dir
from bridge.scan import default_client_scan_id, scan_recording, to_map_payload, write_output
from bridge.synth import SurfaceScenario, simulate_pass

QUALITY_KEYS = {
    "fsHz",
    "jitterMs",
    "dropoutFrac",
    "durationS",
    "gravityPresent",
    "clippingFrac",
    "gpsPresent",
    "gpsAccuracyM",
    "routeLengthM",
    "verdict",
    "problems",
    "warnings",
}
FINDING_KEYS = {
    "index",
    "kind",
    "description",
    "startM",
    "endM",
    "peakM",
    "score",
    "confidence",
    "lat",
    "lng",
    "uncertaintyM",
}
PROVENANCE_KEYS = {
    "recorderApp",
    "recorderVersion",
    "deviceModel",
    "platform",
    "requestedFsHz",
    "measuredFsHz",
    "unitScale",
    "detectorThreshold",
}


def _good_recording(tmp_path, **overrides):
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES), **overrides)
    trace, gps, _truth = simulate_pass(scn)
    write_export_dir(tmp_path / "rec", trace, gps)
    return load_recording(tmp_path / "rec")


def test_map_payload_uses_the_map_field_names(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    payload = to_map_payload(result)

    assert set(payload) == {
        "source",
        "format",
        "quality",
        "cadenceSpm",
        "provenance",
        "findings",
        "clientScanId",
    }
    assert set(payload["quality"]) == QUALITY_KEYS
    assert set(payload["provenance"]) == PROVENANCE_KEYS
    assert payload["quality"]["verdict"] == "ok"
    assert payload["findings"], "expected findings on the seeded anomalous route"
    for finding in payload["findings"]:
        assert set(finding) == FINDING_KEYS
        # `lon` is the bridge's name for it; the map only knows `lng`.
        assert finding["lat"] is not None and finding["lng"] is not None
        assert 0.0 <= finding["confidence"] <= 1.0
        assert finding["startM"] <= finding["peakM"] <= finding["endM"]


def test_map_payload_names_the_recording_without_its_path(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    payload = to_map_payload(result)

    # The scan history is world-readable, so the directory the scan was run
    # from — and the username in it — must not travel with the upload.
    assert payload["source"] == "rec"
    assert "/" not in payload["source"]
    assert str(tmp_path) not in json.dumps(payload)


def test_map_payload_is_json_serialisable_without_a_fallback(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    reloaded = json.loads(json.dumps(to_map_payload(result)))
    assert reloaded["findings"][0]["kind"] in {
        "loose_or_broken_element",
        "compliant_or_absorbing",
    }


def test_unusable_capture_ships_its_verdict_and_no_findings(tmp_path):
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES), fs=50.0, gps_noise_m=8.0)
    trace, gps, _truth = simulate_pass(scn)
    gps.accuracy_m = np.full(gps.t.size, 8.0)
    write_export_dir(tmp_path / "bad", trace, gps)

    result, _pp = scan_recording(load_recording(tmp_path / "bad"))
    payload = to_map_payload(result)

    assert payload["quality"]["verdict"] == "unusable"
    assert payload["quality"]["problems"], "an unusable verdict must say what failed"
    assert payload["findings"] == []


def test_client_scan_id_is_content_addressed(tmp_path):
    rec = _good_recording(tmp_path)
    a, _ = scan_recording(rec)
    b, _ = scan_recording(rec)
    loose, _ = scan_recording(rec, threshold=2.0)

    # Same scan, same id: re-uploading must not create a second scan.
    assert default_client_scan_id(a) == default_client_scan_id(b)
    # Different detector settings are a different claim about the pavement.
    assert default_client_scan_id(loose) != default_client_scan_id(a)
    assert to_map_payload(a, "scan-mine")["clientScanId"] == "scan-mine"


def test_client_scan_id_ignores_where_the_recording_was_scanned_from(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    moved = replace(result, source="/somewhere/else/rec")

    # The id keys the claim the map receives, and the map only receives the
    # bare name — so scanning the same recording from two directories must not
    # import the same findings twice.
    assert default_client_scan_id(moved) == default_client_scan_id(result)


def test_write_output_map_format(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    out = tmp_path / "nested" / "payload.json"
    write_output(result, out, "map", client_scan_id="scan-fixed")

    payload = json.loads(out.read_text())
    assert payload["clientScanId"] == "scan-fixed"
    assert payload["quality"]["verdict"] == "ok"


def test_write_output_rejects_an_unknown_format(tmp_path):
    result, _pp = scan_recording(_good_recording(tmp_path))
    with pytest.raises(ValueError, match="unknown output format"):
        write_output(result, tmp_path / "x", "yaml")


def test_cli_scan_demo_writes_a_map_payload(tmp_path):
    out = tmp_path / "found.map.json"
    code = main(
        [
            "scan",
            "--demo",
            "--sample-dir",
            str(tmp_path / "sample"),
            "--format",
            "map",
            "--out",
            str(out),
        ]
    )
    assert code == 0
    payload = json.loads(out.read_text())
    assert payload["clientScanId"].startswith("scan-")
    assert set(payload["quality"]) == QUALITY_KEYS
