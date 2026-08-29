"""The CI ingest script: what fails the job and what is merely reported.

`scripts/process_recordings.py` runs unattended, so the distinction it draws
between a refused capture (report it, keep going) and a broken pipeline (fail the
job) is the whole point of it — these tests pin that, plus the summary table CI
renders from the outcomes.
"""

from __future__ import annotations

import json
from pathlib import Path

import process_recordings as pr
import pytest


def _payload(verdict: str = "ok", findings: int = 2) -> dict:
    return {
        "source": "run.zip",
        "format": "sensorlogger",
        "quality": {
            "verdict": verdict,
            "fsHz": 199.6,
            "gpsAccuracyM": 2.4,
            "routeLengthM": 412.0,
            "problems": ["median GPS accuracy 8.0 m"] if verdict == "unusable" else [],
        },
        "findings": [{"index": i} for i in range(findings)],
        "clientScanId": "scan-abc123",
    }


@pytest.fixture
def fake_scan(monkeypatch: pytest.MonkeyPatch):
    """Stand in for `bridge scan`, writing a payload and returning an exit code."""

    def install(payload: dict | str, code: int = 0) -> None:
        def _run(cmd: list[str], **kwargs: object) -> _FakeProc:
            out = Path(cmd[cmd.index("--out") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(payload if isinstance(payload, str) else json.dumps(payload))
            return _FakeProc(code)

        monkeypatch.setattr(pr.subprocess, "run", _run)

    return install


class _FakeProc:
    def __init__(self, code: int) -> None:
        self.returncode = code
        self.stdout = "verdict OK\n"
        self.stderr = ""


def test_ok_capture_is_uploaded_and_reports_its_ids(fake_scan, tmp_path, monkeypatch):
    fake_scan(_payload())
    posted: list[dict] = []
    monkeypatch.setattr(pr, "upload", lambda url, payload: posted.append(payload) or ["rep-1", "rep-2"])

    outcome = pr.process(tmp_path / "run.zip", tmp_path / "out", "https://example.test")

    assert posted[0]["clientScanId"] == "scan-abc123"
    assert outcome.uploaded and outcome.report_ids == ["rep-1", "rep-2"]
    assert outcome.verdict == "ok" and outcome.findings == 2
    assert (tmp_path / "out" / "run.payload.json").exists()


def test_unusable_capture_is_reported_but_not_uploaded(fake_scan, tmp_path, monkeypatch):
    # `bridge scan` exits 1 on a refused capture; that is evidence about the
    # recording, so the job must survive it.
    fake_scan(_payload(verdict="unusable", findings=0), code=1)
    monkeypatch.setattr(pr, "upload", lambda url, payload: pytest.fail("must not upload"))

    outcome = pr.process(tmp_path / "run.zip", tmp_path / "out", "https://example.test")

    assert not outcome.uploaded and outcome.verdict == "unusable"
    assert "GPS accuracy" in outcome.detail
    argv = ["--api-url", "https://example.test", "--out-dir", str(tmp_path), str(tmp_path / "r.zip")]
    assert pr.main(argv) == 0


def test_scan_crash_fails_the_job(fake_scan, tmp_path, monkeypatch):
    monkeypatch.setattr(pr.subprocess, "run", lambda *a, **k: _FakeProc(2))
    monkeypatch.setattr(pr, "upload", lambda url, payload: pytest.fail("must not upload"))

    with pytest.raises(pr.ProcessingError, match="exited 2"):
        pr.scan(tmp_path / "run.zip", tmp_path / "out" / "run.payload.json")
    argv = ["--api-url", "https://x.test", "--out-dir", str(tmp_path), str(tmp_path / "r.zip")]
    assert pr.main(argv) == 1


def test_malformed_payload_fails_the_job(fake_scan, tmp_path):
    fake_scan("not json at all")

    with pytest.raises(pr.ProcessingError, match="not valid JSON"):
        pr.process(tmp_path / "run.zip", tmp_path / "out", "https://example.test")


def test_payload_without_client_scan_id_fails_the_job(fake_scan, tmp_path):
    # Wrong `--format`: no content hash means no idempotent upsert.
    fake_scan(json.dumps({"findings": []}))

    with pytest.raises(pr.ProcessingError, match="not a --format map payload"):
        pr.process(tmp_path / "run.zip", tmp_path / "out", "https://example.test")


def test_api_error_fails_the_job(fake_scan, tmp_path, monkeypatch):
    fake_scan(_payload())

    def _boom(url, payload):
        raise pr.ProcessingError("scan.ingest failed: HTTP 500")

    monkeypatch.setattr(pr, "upload", _boom)
    with pytest.raises(pr.ProcessingError, match="HTTP 500"):
        pr.process(tmp_path / "run.zip", tmp_path / "out", "https://example.test")


def test_summary_table_has_one_row_per_recording():
    outcomes = [
        pr.Outcome(
            recording="good.zip",
            verdict="ok",
            fs_hz=199.6,
            gps_accuracy_m=2.4,
            route_length_m=412.0,
            findings=2,
            report_ids=["rep-1"],
            uploaded=True,
        ),
        pr.Outcome(recording="bad.zip", verdict="unusable", findings=0, detail="GPS accuracy 8.0 m"),
    ]

    table = pr.summary_table(outcomes, "https://example.test")
    rows = [line for line in table.splitlines() if line.startswith("| `")]

    assert len(rows) == 2
    assert "OK" in rows[0] and "200 Hz" in rows[0] and "`rep-1`" in rows[0]
    assert "[map](https://example.test)" in rows[0]
    assert "UNUSABLE" in rows[1] and "skipped" in rows[1] and "[map]" not in rows[1]
    assert "GPS accuracy 8.0 m" in table
