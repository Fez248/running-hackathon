"""Scan committed recordings and upload the findings to the Sidewalk Map.

This is the CI half of the capture loop: a Sensor Logger export lands in
``recordings/`` on ``main``, ``.github/workflows/process-recordings.yml`` runs
this script over the files that push added or changed, and each scan's map
payload is POSTed to ``scan.ingest`` so the findings appear on the map without
anyone running the pipeline by hand.

Two failure modes are deliberately different:

* a **rejected capture** (the quality gate's ``unusable`` verdict, which makes
  ``bridge scan`` exit 1) is a fact about the recording, not a broken build: it
  is reported in the job summary, not uploaded, and does not fail the job;
* a **crash, an API error or a payload that is not the agreed shape** is a
  broken build and fails the job, because nobody would otherwise notice that the
  recordings stopped reaching the map.

Uploads are idempotent: the payload carries bridge's content-hashed
``clientScanId``, and ``scan.ingest`` upserts on it, so re-running the workflow
over the same recording resolves to the same scan and the same reports.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

INGEST_PATH = "/api/trpc/scan.ingest"
HTTP_TIMEOUT_S = 120.0
# `bridge scan` exits 1 when the quality gate refuses the capture; any other
# non-zero exit is the pipeline itself failing.
REJECTED_EXIT_CODE = 1


class ProcessingError(RuntimeError):
    """A genuine failure: the recording could not be processed at all."""


@dataclass
class Outcome:
    """One recording's fate, as the job summary reports it."""

    recording: str
    verdict: str
    fs_hz: float | None = None
    gps_accuracy_m: float | None = None
    route_length_m: float | None = None
    findings: int | None = None
    report_ids: list[str] | None = None
    uploaded: bool = False
    detail: str = ""


def scan(recording: Path, payload_path: Path) -> tuple[int, dict[str, Any], str]:
    """Run ``bridge scan --format map`` over one recording.

    Returns the exit code, the map payload and the CLI's own report. The payload
    is written whatever the verdict, so a rejected capture can still be
    summarised (its findings are withheld by the scanner, not by this script).
    """
    payload_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "bridge.cli",
            "scan",
            str(recording),
            "--format",
            "map",
            "--out",
            str(payload_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    report = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode not in (0, REJECTED_EXIT_CODE):
        raise ProcessingError(f"bridge scan exited {proc.returncode}\n{report.strip()}")
    if not payload_path.exists():
        raise ProcessingError(f"bridge scan wrote no payload to {payload_path}\n{report.strip()}")
    try:
        payload = json.loads(payload_path.read_text())
    except json.JSONDecodeError as exc:
        raise ProcessingError(f"{payload_path} is not valid JSON: {exc}") from None
    if not isinstance(payload, dict) or "clientScanId" not in payload:
        raise ProcessingError(f"{payload_path} is not a --format map payload")
    return proc.returncode, payload, report


def upload(api_url: str, payload: dict[str, Any], *, timeout: float = HTTP_TIMEOUT_S) -> list[str]:
    """POST one map payload to ``scan.ingest``; return the report ids it created.

    ``scan.ingest`` is a ``publicProcedure``, so no credential is involved — the
    superjson envelope (``{"json": ...}``) is the whole protocol.
    """
    request = urllib.request.Request(
        f"{api_url.rstrip('/')}{INGEST_PATH}",
        method="POST",
        data=json.dumps({"json": payload}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise ProcessingError(f"scan.ingest failed: HTTP {exc.code} {body}") from None
    except urllib.error.URLError as exc:
        raise ProcessingError(f"scan.ingest failed: {exc.reason}") from None

    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise ProcessingError(f"scan.ingest returned invalid JSON: {raw[:200]}") from None
    if not isinstance(body, dict) or "error" in body:
        raise ProcessingError(f"scan.ingest returned an error: {raw[:500]}")
    data = body.get("result", {}).get("data") if isinstance(body.get("result"), dict) else None
    if isinstance(data, dict) and isinstance(data.get("json"), dict):
        data = data["json"]
    if not isinstance(data, dict) or not isinstance(data.get("reportIds"), list):
        raise ProcessingError(f"scan.ingest returned an unexpected shape: {raw[:500]}")
    return [str(report_id) for report_id in data["reportIds"]]


def process(recording: Path, out_dir: Path, api_url: str) -> Outcome:
    """Scan one recording and, unless the capture was refused, upload it."""
    payload_path = out_dir / f"{recording.stem}.payload.json"
    code, payload, report = scan(recording, payload_path)
    quality = payload.get("quality", {})
    outcome = Outcome(
        recording=recording.name,
        verdict=str(quality.get("verdict", "unknown")),
        fs_hz=quality.get("fsHz"),
        gps_accuracy_m=quality.get("gpsAccuracyM"),
        route_length_m=quality.get("routeLengthM"),
        findings=len(payload.get("findings", [])),
    )
    if code == REJECTED_EXIT_CODE or outcome.verdict == "unusable":
        problems = quality.get("problems") or ["capture refused by the quality gate"]
        outcome.detail = "; ".join(str(p) for p in problems)
        print(f"::warning file={recording}::rejected capture, not uploaded: {outcome.detail}")
        print(report)
        return outcome
    outcome.report_ids = upload(api_url, payload)
    outcome.uploaded = True
    print(report)
    return outcome


def _cell(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def summary_table(outcomes: list[Outcome], api_url: str) -> str:
    """The job summary: one row per recording, in the order they were processed."""
    lines = [
        "## Recordings processed",
        "",
        "| Recording | Verdict | Sample rate | GPS accuracy | Route | Findings | Reports created | Map |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for o in outcomes:
        if o.report_ids is None:
            reports = "skipped" if o.verdict == "unusable" else "—"
        else:
            reports = ", ".join(f"`{r}`" for r in o.report_ids) or "none"
        lines.append(
            f"| `{o.recording}` | {o.verdict.upper()} | {_cell(o.fs_hz, 0)} Hz | "
            f"{_cell(o.gps_accuracy_m)} m | {_cell(o.route_length_m, 0)} m | "
            f"{'—' if o.findings is None else o.findings} | {reports} | "
            f"{f'[map]({api_url})' if o.uploaded else '—'} |"
        )
    # Failures get their own section, listing the error rather than a verdict.
    rejected = [o for o in outcomes if not o.uploaded and o.verdict != "error"]
    if rejected:
        lines += ["", "### Not uploaded", ""]
        lines += [f"- `{o.recording}`: {o.detail}" for o in rejected]
    return "\n".join(lines) + "\n"


def write_summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text)
    print(text)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("recordings", nargs="*", type=Path, help="recording files to scan")
    p.add_argument("--api-url", default=os.environ.get("SIDEWALK_API_URL", ""))
    p.add_argument("--out-dir", type=Path, default=Path("payloads"))
    args = p.parse_args(argv)

    if not args.recordings:
        write_summary("## Recordings processed\n\nNo added or modified recordings in this push.\n")
        return 0
    if not args.api_url:
        print("error: SIDEWALK_API_URL is not set")
        return 2

    outcomes: list[Outcome] = []
    failures: list[str] = []
    for recording in args.recordings:
        try:
            outcomes.append(process(recording, args.out_dir, args.api_url))
        except ProcessingError as exc:
            # Keep going: one broken recording must not hide the fate of the
            # others, and the job fails once at the end.
            failures.append(f"`{recording.name}`: {exc}")
            outcomes.append(Outcome(recording=recording.name, verdict="error", detail=str(exc)))
            print(f"::error file={recording}::{exc}")

    text = summary_table(outcomes, args.api_url)
    if failures:
        text += "\n### Failed\n\n" + "\n".join(f"- {f}" for f in failures) + "\n"
    write_summary(text)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
