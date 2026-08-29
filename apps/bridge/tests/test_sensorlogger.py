"""Sensor Logger Studies sync worker: download, scan, report, secret hygiene."""

from __future__ import annotations

import json
import urllib.error
import zipfile
from pathlib import Path

import pytest

from bridge.experiments import ROUTE_ANOMALIES
from bridge.ingest import load_recording, write_export_dir
from bridge.scan import scan_recording
from bridge.sensorlogger import (
    STUDY_API_ORIGIN,
    SidewalkClient,
    SyncConfig,
    SyncError,
    _NoRedirectHandler,
    download_recording,
    feedback_markdown,
    process_upload,
    redact,
    scan_payload,
    study_file_url,
    study_webhook_url,
    sync_once,
)
from bridge.synth import SurfaceScenario, simulate_pass

SECRET = "sl-secret-code-do-not-log"
TOKEN = "worker-bearer-token"


def _config(**overrides) -> SyncConfig:
    base = {
        "api_base_url": "https://sidewalk.example",
        "worker_token": TOKEN,
        "secret_code": SECRET,
    }
    return SyncConfig(**{**base, **overrides})


def _recording_zip(tmp_path: Path, **scenario) -> bytes:
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES), **scenario)
    trace, gps, _truth = simulate_pass(scn)
    src = tmp_path / "export"
    write_export_dir(src, trace, gps)
    archive = tmp_path / "export.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(src.iterdir()):
            zf.write(f, f.name)
    return archive.read_bytes()


class FakeResponse:
    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        self._body = body
        self._offset = 0
        self.headers = {"Content-Length": str(len(body))} if headers is None else headers

    def read(self, size: int | None = None) -> bytes:
        chunk = self._body[self._offset :] if size is None else self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


class FakeHttp:
    """Records every request and answers by URL path."""

    def __init__(self, *, recording: bytes = b"", uploads: list[dict[str, str]] | None = None) -> None:
        self.recording = recording
        self.uploads = uploads or []
        self.requests: list[tuple[str, str, dict[str, str], bytes | None]] = []
        self.claim_calls = 0
        self.download_error: Exception | None = None

    def __call__(self, request, timeout: float | None = None) -> FakeResponse:  # noqa: ANN001
        body = request.data
        self.requests.append((request.method, request.full_url, dict(request.headers), body))
        url = request.full_url
        if url.startswith(f"{STUDY_API_ORIGIN}/api/study/file/v1"):
            if self.download_error is not None:
                raise self.download_error
            return FakeResponse(self.recording)
        if url.startswith(f"{STUDY_API_ORIGIN}/api/study/webhook/v1"):
            return FakeResponse(b"")
        if url.endswith("/jobs/claim"):
            self.claim_calls += 1
            uploads = self.uploads if self.claim_calls == 1 else []
            return FakeResponse(json.dumps({"uploads": uploads}).encode())
        if url.endswith("/jobs/complete"):
            return FakeResponse(json.dumps({"status": "recorded", "reportCount": 2}).encode())
        raise AssertionError(f"unexpected request to {url}")

    def sidewalk_traffic(self) -> str:
        """Everything the worker sent to the Sidewalk server, for leak assertions."""
        return "\n".join(
            f"{method} {url} {headers} {(body or b'').decode('utf-8', 'replace')}"
            for method, url, headers, body in self.requests
            if STUDY_API_ORIGIN not in url
        )

    def posted(self, suffix: str) -> list[dict[str, object]]:
        return [
            json.loads((body or b"{}").decode())
            for _m, url, _h, body in self.requests
            if url.endswith(suffix)
        ]


def test_study_urls_encode_ids_and_stay_on_the_study_host():
    url = study_file_url("study 1", "up/../load")
    assert url.startswith(f"{STUDY_API_ORIGIN}/api/study/file/v1?")
    # Ids come from an untrusted webhook payload, so they must not be able to
    # alter the path or add parameters.
    assert "studyId=study+1" in url and "uploadId=up%2F..%2Fload" in url
    assert study_webhook_url("s", "u").startswith(f"{STUDY_API_ORIGIN}/api/study/webhook/v1?")


def test_redact_scrubs_every_secret():
    assert redact(f"boom {SECRET} and {TOKEN}", SECRET, TOKEN) == "boom *** and ***"
    assert redact("clean", None) == "clean"


def test_download_sends_the_secret_only_as_authorization(tmp_path):
    http = FakeHttp(recording=b"zip-bytes")
    dest = tmp_path / "rec.zip"

    size = download_recording("s1", "u1", SECRET, dest, opener=http)

    assert size == len(b"zip-bytes") and dest.read_bytes() == b"zip-bytes"
    _method, url, headers, _body = http.requests[0]
    assert headers["Authorization"] == SECRET
    assert SECRET not in url


def test_download_rejects_an_oversized_recording_by_content_length(tmp_path):
    http = FakeHttp(recording=b"x" * 10)
    with pytest.raises(SyncError, match="over the 4 byte limit"):
        download_recording("s1", "u1", SECRET, tmp_path / "r.zip", opener=http, max_bytes=4)


def test_download_stops_streaming_when_the_limit_is_passed(tmp_path):
    class Unbounded(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            return FakeResponse(b"y" * 4096, headers={})

    with pytest.raises(SyncError, match="exceeds the 8 byte limit"):
        download_recording("s1", "u1", SECRET, tmp_path / "r.zip", opener=Unbounded(), max_bytes=8)


def test_download_error_never_echoes_the_secret(tmp_path):
    http = FakeHttp()
    http.download_error = urllib.error.URLError(f"tls failure for token {SECRET}")

    with pytest.raises(SyncError) as exc:
        download_recording("s1", "u1", SECRET, tmp_path / "r.zip", opener=http)
    assert SECRET not in str(exc.value)


def test_empty_download_is_a_failure(tmp_path):
    with pytest.raises(SyncError, match="empty response"):
        download_recording("s1", "u1", SECRET, tmp_path / "r.zip", opener=FakeHttp(recording=b""))


def test_scan_payload_matches_the_completion_contract(tmp_path):
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES))
    trace, gps, _ = simulate_pass(scn)
    write_export_dir(tmp_path / "rec", trace, gps)
    result, _pp = scan_recording(load_recording(tmp_path / "rec"))

    payload = scan_payload(result)

    assert payload["format"] == "sensorlogger"
    assert payload["quality"] == {
        "verdict": result.quality.verdict,
        "usable": True,
        "reasons": [*result.quality.problems, *result.quality.warnings],
    }
    assert "source" not in payload
    assert payload["findings"] and set(payload["findings"][0]) == {
        "index",
        "kind",
        "description",
        "start_m",
        "end_m",
        "peak_m",
        "score",
        "confidence",
        "lat",
        "lon",
    }
    # Must survive the JSON round trip the server validates.
    assert json.loads(json.dumps(payload))["n_footfalls"] == result.n_footfalls


def test_feedback_markdown_reports_findings_and_refuses_to_conclude_on_bad_captures(tmp_path):
    trace, gps, _ = simulate_pass(SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES)))
    write_export_dir(tmp_path / "good", trace, gps)
    good, _ = scan_recording(load_recording(tmp_path / "good"))
    md = feedback_markdown(good)
    assert md.startswith("# Sidewalk Map")
    assert "steps/min" in md and "confidence" in md

    trace_bad, gps_bad, _ = simulate_pass(SurfaceScenario(seed=3, fs=30.0))
    write_export_dir(tmp_path / "bad", trace_bad, gps_bad)
    bad, _ = scan_recording(load_recording(tmp_path / "bad"))
    bad_md = feedback_markdown(bad)
    assert "No findings" in bad_md and "re-record" in bad_md


def test_sync_once_downloads_scans_and_reports_without_leaking_credentials(tmp_path):
    http = FakeHttp(
        recording=_recording_zip(tmp_path),
        uploads=[{"studyId": "s1", "uploadId": "u1"}],
    )

    outcomes = sync_once(_config(send_feedback=True), opener=http)

    assert len(outcomes) == 1
    outcome = outcomes[0]
    assert outcome["status"] == "done" and outcome["quality"] == "ok"
    assert outcome["findings"] > 0 and outcome["reportCount"] == 2

    completion = http.posted("/jobs/complete")[0]
    assert completion["studyId"] == "s1" and completion["uploadId"] == "u1"
    assert completion["bytes"] == outcome["bytes"]
    assert "secretCode" not in completion
    assert isinstance(completion["scan"], dict)

    # Feedback went back to the Study, authenticated with the secret.
    feedback = [r for r in http.requests if "/study/webhook/v1" in r[1]]
    assert feedback and feedback[0][2]["Content-type"] == "text/markdown"

    # The Study secret must never reach the Sidewalk server.
    assert SECRET not in http.sidewalk_traffic()


def test_a_failed_download_is_reported_as_a_redacted_failure(tmp_path):
    http = FakeHttp(uploads=[{"studyId": "s1", "uploadId": "u1"}])
    http.download_error = urllib.error.URLError(f"refused ({SECRET})")

    outcomes = sync_once(_config(), opener=http)

    assert outcomes[0]["status"] == "failed"
    completion = http.posted("/jobs/complete")[0]
    assert "error" in completion and "scan" not in completion
    assert SECRET not in http.sidewalk_traffic()


def test_a_corrupt_recording_fails_the_upload_rather_than_the_worker(tmp_path):
    http = FakeHttp(recording=b"not a zip", uploads=[{"studyId": "s1", "uploadId": "u1"}])

    outcomes = sync_once(_config(), opener=http)

    assert outcomes[0]["status"] == "failed"
    assert http.posted("/jobs/complete")[0].get("scan") is None


def test_malformed_uploads_in_a_claim_are_skipped(tmp_path):
    http = FakeHttp(uploads=[{"studyId": "s1"}, {"uploadId": "u2"}, "nope"])  # type: ignore[list-item]
    assert sync_once(_config(), opener=http) == []


def test_client_sends_the_worker_bearer_token_and_caps_error_length():
    http = FakeHttp()
    client = SidewalkClient(_config(), opener=http)

    client.complete("s1", "u1", error=f"{SECRET} " + "x" * 5000)

    _method, url, headers, body = http.requests[-1]
    assert url == "https://sidewalk.example/api/integrations/sensor-logger/jobs/complete"
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    payload = json.loads((body or b"{}").decode())
    assert len(payload["error"]) == 1000 and SECRET not in payload["error"]


def test_client_surfaces_http_failures_without_the_token():
    class Failing(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            raise urllib.error.HTTPError(request.full_url, 503, "unavailable", {}, None)  # type: ignore[arg-type]

    with pytest.raises(SyncError) as exc:
        SidewalkClient(_config(), opener=Failing()).claim()
    assert "HTTP 503" in str(exc.value) and TOKEN not in str(exc.value)


def test_config_from_env_requires_the_credentials_and_parses_options():
    with pytest.raises(SyncError, match="SIDEWALK_API_URL"):
        SyncConfig.from_env({})

    config = SyncConfig.from_env(
        {
            "SIDEWALK_API_URL": "https://sidewalk.example/",
            "SENSOR_LOGGER_WORKER_TOKEN": TOKEN,
            "SENSOR_LOGGER_SECRET_CODE": SECRET,
            "SENSOR_LOGGER_CLAIM_LIMIT": "3",
            "SENSOR_LOGGER_POST_FEEDBACK": "true",
        }
    )
    assert config.api_base_url == "https://sidewalk.example"
    assert config.claim_limit == 3 and config.send_feedback is True


def _env(**overrides) -> dict[str, str]:
    return {
        "SIDEWALK_API_URL": "https://sidewalk.example",
        "SENSOR_LOGGER_WORKER_TOKEN": TOKEN,
        "SENSOR_LOGGER_SECRET_CODE": SECRET,
        **overrides,
    }


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"SENSOR_LOGGER_CLAIM_LIMIT": "many"}, "SENSOR_LOGGER_CLAIM_LIMIT"),
        ({"SENSOR_LOGGER_CLAIM_LIMIT": "0"}, "SENSOR_LOGGER_CLAIM_LIMIT"),
        # The server contract caps a claim at 25.
        ({"SENSOR_LOGGER_CLAIM_LIMIT": "26"}, "at most 25"),
        ({"SENSOR_LOGGER_MAX_DOWNLOAD_BYTES": "-1"}, "SENSOR_LOGGER_MAX_DOWNLOAD_BYTES"),
        ({"SENSOR_LOGGER_HTTP_TIMEOUT_S": "soon"}, "SENSOR_LOGGER_HTTP_TIMEOUT_S"),
        ({"SENSOR_LOGGER_HTTP_TIMEOUT_S": "nan"}, "SENSOR_LOGGER_HTTP_TIMEOUT_S"),
        ({"SENSOR_LOGGER_HTTP_TIMEOUT_S": "0"}, "SENSOR_LOGGER_HTTP_TIMEOUT_S"),
        # The bearer token would otherwise travel in plaintext.
        ({"SIDEWALK_API_URL": "http://sidewalk.example"}, "https"),
        ({"SIDEWALK_API_URL": "sidewalk.example"}, "absolute URL"),
    ],
)
def test_config_rejects_malformed_settings_as_sync_errors(overrides, match):
    with pytest.raises(SyncError, match=match):
        SyncConfig.from_env(_env(**overrides))


def test_config_allows_plaintext_only_for_a_local_server():
    assert (
        SyncConfig.from_env(_env(SIDEWALK_API_URL="http://localhost:3000")).api_base_url
        == "http://localhost:3000"
    )


def test_study_calls_never_follow_a_redirect():
    # The Study calls carry a Study-wide credential, so a 3xx must not be replayed
    # against another host; urllib turns a `None` here into an HTTPError.
    handler = _NoRedirectHandler()
    assert (
        handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example/steal") is None
    )


def test_a_malformed_response_is_a_sync_error_not_a_crash():
    class Garbage(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            return FakeResponse(b"<html>gateway</html>")

    with pytest.raises(SyncError, match="invalid JSON"):
        SidewalkClient(_config(), opener=Garbage()).claim()


def test_a_non_utf8_response_is_a_sync_error_not_a_crash():
    class Binary(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            return FakeResponse(b"\xff\xfe\x00garbage")

    with pytest.raises(SyncError, match="invalid UTF-8"):
        SidewalkClient(_config(), opener=Binary()).claim()


def test_a_completion_outage_does_not_abandon_the_rest_of_the_batch(tmp_path):
    class NoCompletions(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            if request.full_url.endswith("/jobs/complete"):
                raise urllib.error.HTTPError(request.full_url, 502, "down", {}, None)  # type: ignore[arg-type]
            return super().__call__(request, timeout)

    # One upload scans, one fails to download: both completion paths hit the outage.
    http = NoCompletions(
        recording=_recording_zip(tmp_path),
        uploads=[{"studyId": "s1", "uploadId": "u1"}, {"studyId": "s1", "uploadId": "u2"}],
    )
    scanned = sync_once(_config(), opener=http)

    assert [o["uploadId"] for o in scanned] == ["u1", "u2"]
    # Unreported, so the lease expires and the server hands the upload out again.
    assert all(o["status"] == "unreported" for o in scanned)
    assert all("HTTP 502" in str(o["reportError"]) for o in scanned)

    http.download_error = urllib.error.URLError("refused")
    http.claim_calls = 0
    failed = sync_once(_config(), opener=http)
    assert [o["status"] for o in failed] == ["failed", "failed"]
    assert all("HTTP 502" in str(o["reportError"]) for o in failed)


def test_feedback_failure_does_not_undo_a_recorded_scan(tmp_path):
    class NoFeedback(FakeHttp):
        def __call__(self, request, timeout=None):  # noqa: ANN001
            if "/study/webhook/v1" in request.full_url:
                raise urllib.error.HTTPError(request.full_url, 500, "nope", {}, None)  # type: ignore[arg-type]
            return super().__call__(request, timeout)

    http = NoFeedback(recording=_recording_zip(tmp_path))
    config = _config(send_feedback=True)
    outcome = process_upload("s1", "u1", config, SidewalkClient(config, opener=http), opener=http)

    assert outcome["status"] == "done"
    assert "HTTP 500" in str(outcome["feedbackError"])
