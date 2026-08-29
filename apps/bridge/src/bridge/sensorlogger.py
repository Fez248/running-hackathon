"""Sensor Logger Studies sync worker: uploaded recording -> scan -> Sidewalk Map.

The Sidewalk web app receives the Study webhook and records the upload as
pending work (``libs/api/src/integrations/sensor-logger.ts``). This module is the
other end: it leases those uploads, downloads each recording from the Study API,
runs it through the existing ``ingest -> quality -> scan`` pipeline, hands the
findings back to the server, and optionally posts a Markdown report back to the
participant.

The split exists because the scan is numpy/scipy Python and the deployed web app
is Node on Vercel; the worker runs wherever the pipeline already runs (a laptop,
a cron box, a container).

References:
* https://github.com/tszheichoi/awesome-sensor-logger/blob/main/STUDY_WEBHOOKS.md
* https://github.com/tszheichoi/awesome-sensor-logger/blob/main/STUDY_API.md

Secret handling: the Study ``secretCode`` is read from the environment, sent only
as an ``Authorization`` header to ``sensorlogger.app``, and scrubbed from every
message this module produces (see :func:`redact`). It is never written to the
Sidewalk server, to a file, or to a log line.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .ingest import load_recording
from .scan import ScanResult, scan_recording

# The Study API host is fixed, never taken from the webhook payload: the only
# attacker-influenced values are the two ids, which are URL-encoded into the
# query string, so no payload can redirect the download somewhere else.
STUDY_API_ORIGIN = "https://sensorlogger.app"
STUDY_FILE_PATH = "/api/study/file/v1"
STUDY_WEBHOOK_PATH = "/api/study/webhook/v1"

# A Study recording is a zip of CSVs; a few hundred MB is already an hour at
# 400 Hz (see ingest.MAX_ARCHIVE_BYTES), and refusing early keeps a hostile or
# broken upload from filling the worker's disk.
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
HTTP_TIMEOUT_S = 120.0
# How many uploads one cycle leases. The server caps this at 25.
DEFAULT_CLAIM_LIMIT = 5
MAX_CLAIM_LIMIT = 25

REDACTED = "***"

# Injection point for tests: same shape as ``urllib.request.urlopen``.
Opener = Callable[..., Any]


class SyncError(RuntimeError):
    """A sync step failed. The message is always already redacted."""


def redact(text: str, *secrets: str | None) -> str:
    """Replace every configured secret in ``text`` with ``***``."""
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, REDACTED)
    return out


def study_file_url(study_id: str, upload_id: str) -> str:
    """Download URL for one uploaded recording (STUDY_API.md)."""
    query = urllib.parse.urlencode({"studyId": study_id, "uploadId": upload_id})
    return f"{STUDY_API_ORIGIN}{STUDY_FILE_PATH}?{query}"


def study_webhook_url(study_id: str, upload_id: str) -> str:
    """Feedback URL for one uploaded recording (STUDY_WEBHOOKS.md)."""
    query = urllib.parse.urlencode({"studyId": study_id, "uploadId": upload_id})
    return f"{STUDY_API_ORIGIN}{STUDY_WEBHOOK_PATH}?{query}"


def _require_study_origin(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    expected = urllib.parse.urlsplit(STUDY_API_ORIGIN)
    if (parsed.scheme, parsed.netloc) != (expected.scheme, expected.netloc):
        raise SyncError(f"refusing to call {parsed.scheme}://{parsed.netloc}: not the Study API")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: the Study calls carry a Study-wide credential.

    Returning ``None`` makes urllib surface the 3xx as an ``HTTPError`` instead of
    replaying the ``Authorization`` header against whatever host it points at.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


_STUDY_OPENER = urllib.request.build_opener(_NoRedirectHandler)


def study_opener(request: urllib.request.Request, timeout: float | None = None) -> Any:
    """Default opener for Study API calls: same shape as ``urlopen``, no redirects."""
    return _STUDY_OPENER.open(request, timeout=timeout)


def _content_length(headers: Any) -> int | None:
    raw = headers.get("Content-Length")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def download_recording(
    study_id: str,
    upload_id: str,
    secret_code: str,
    dest: Path,
    *,
    opener: Opener = study_opener,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
    timeout: float = HTTP_TIMEOUT_S,
) -> int:
    """Download one Study recording to ``dest``; return the byte count.

    Streams in chunks and aborts as soon as ``max_bytes`` is exceeded, so an
    oversized recording is never fully buffered or written.
    """
    url = study_file_url(study_id, upload_id)
    _require_study_origin(url)
    request = urllib.request.Request(url, method="GET", headers={"Authorization": secret_code})
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with opener(request, timeout=timeout) as response:
            declared = _content_length(response.headers)
            if declared is not None and declared > max_bytes:
                raise SyncError(f"recording is {declared} bytes, over the {max_bytes} byte limit")
            with dest.open("wb") as fh:
                while True:
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise SyncError(f"recording exceeds the {max_bytes} byte limit")
                    fh.write(chunk)
    except urllib.error.HTTPError as exc:  # pragma: no cover - exercised via fakes
        raise SyncError(f"download failed: HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise SyncError(redact(f"download failed: {exc.reason}", secret_code)) from None
    if written == 0:
        raise SyncError("download failed: empty response")
    return written


def scan_payload(result: ScanResult) -> dict[str, Any]:
    """``ScanResult`` -> the JSON the server's completion endpoint validates.

    ``ScanResult.source`` is deliberately dropped: it is a path on the worker's
    disk and the server has no use for it.
    """
    quality = result.quality
    return {
        "format": result.format,
        "quality": {
            "verdict": quality.verdict,
            "usable": bool(quality.usable),
            "reasons": [*quality.problems, *quality.warnings],
        },
        "cadence_spm": result.cadence_spm,
        "n_windows": result.n_windows,
        "n_footfalls": result.n_footfalls,
        "findings": [
            {
                "index": f.index,
                "kind": f.kind,
                "description": f.description,
                "start_m": f.start_m,
                "end_m": f.end_m,
                "peak_m": f.peak_m,
                "score": f.score,
                "confidence": f.confidence,
                "lat": f.lat,
                "lon": f.lon,
            }
            for f in result.findings
        ],
        "notes": result.notes,
    }


def feedback_markdown(result: ScanResult) -> str:
    """Participant-facing report, posted back into the Sensor Logger app."""
    quality = result.quality
    lines = [
        "# Sidewalk Map — surface scan",
        "",
        f"**Capture:** {quality.fs_hz:.0f} Hz IMU, {quality.duration_s:.0f} s "
        f"({quality.verdict.upper()})",
    ]
    for problem in quality.problems:
        lines.append(f"- ⚠️ {problem}")
    for warning in quality.warnings:
        lines.append(f"- {warning}")

    if not quality.usable:
        lines += [
            "",
            "No findings: this recording cannot support a conclusion about the surface.",
            "Please re-record following the capture checklist and upload again.",
        ]
        return "\n".join(lines) + "\n"

    lines += [
        "",
        f"**Gait:** {result.cadence_spm:.0f} steps/min over {result.n_footfalls} footfalls",
        "",
        f"## Findings ({len(result.findings)})",
    ]
    if not result.findings:
        lines.append("")
        lines.append("Nothing stood out along this route — a uniform surface.")
    for finding in result.findings:
        where = (
            f" at `{finding.lat:.5f}, {finding.lon:.5f}`" if finding.lat is not None else " (no GPS fix)"
        )
        lines.append(
            f"- **{finding.peak_m:.0f} m in**{where}: {finding.description} "
            f"(confidence {finding.confidence:.2f})"
        )
    for note in result.notes:
        lines.append(f"- _{note}_")
    return "\n".join(lines) + "\n"


def post_feedback(
    study_id: str,
    upload_id: str,
    secret_code: str,
    markdown: str,
    *,
    opener: Opener = study_opener,
    timeout: float = HTTP_TIMEOUT_S,
) -> None:
    """POST a Markdown report back to the participant (Notify & Respond mode)."""
    url = study_webhook_url(study_id, upload_id)
    _require_study_origin(url)
    request = urllib.request.Request(
        url,
        method="POST",
        data=markdown.encode("utf-8"),
        headers={"Authorization": secret_code, "Content-Type": "text/markdown"},
    )
    try:
        with opener(request, timeout=timeout) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        raise SyncError(f"feedback POST failed: HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise SyncError(redact(f"feedback POST failed: {exc.reason}", secret_code)) from None


def _positive_int(
    src: Mapping[str, str], name: str, default: int, *, maximum: int | None = None
) -> int:
    raw = src.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise SyncError(f"{name} must be a whole number") from None
    if value < 1 or (maximum is not None and value > maximum):
        upper = "" if maximum is None else f" and at most {maximum}"
        raise SyncError(f"{name} must be at least 1{upper}")
    return value


def _positive_float(src: Mapping[str, str], name: str, default: float) -> float:
    raw = src.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise SyncError(f"{name} must be a number") from None
    if not math.isfinite(value) or value <= 0:
        raise SyncError(f"{name} must be a positive number of seconds")
    return value


def _api_base_url(raw: str) -> str:
    """Sidewalk base URL. HTTPS only: every call carries the worker bearer token."""
    url = raw.rstrip("/")
    parsed = urllib.parse.urlsplit(url)
    if not parsed.netloc:
        raise SyncError("SIDEWALK_API_URL must be an absolute URL")
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise SyncError("SIDEWALK_API_URL must use https (http is allowed only for localhost)")
    return url


@dataclass
class SyncConfig:
    """Worker configuration; every field comes from the environment."""

    api_base_url: str
    worker_token: str
    secret_code: str
    claim_limit: int = DEFAULT_CLAIM_LIMIT
    send_feedback: bool = False
    max_download_bytes: int = MAX_DOWNLOAD_BYTES
    timeout_s: float = HTTP_TIMEOUT_S

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> SyncConfig:
        src = os.environ if env is None else env
        missing = [
            name
            for name in ("SIDEWALK_API_URL", "SENSOR_LOGGER_WORKER_TOKEN", "SENSOR_LOGGER_SECRET_CODE")
            if not src.get(name)
        ]
        if missing:
            raise SyncError(f"missing environment variables: {', '.join(missing)}")
        return cls(
            api_base_url=_api_base_url(src["SIDEWALK_API_URL"]),
            worker_token=src["SENSOR_LOGGER_WORKER_TOKEN"],
            secret_code=src["SENSOR_LOGGER_SECRET_CODE"],
            claim_limit=_positive_int(
                src, "SENSOR_LOGGER_CLAIM_LIMIT", DEFAULT_CLAIM_LIMIT, maximum=MAX_CLAIM_LIMIT
            ),
            send_feedback=src.get("SENSOR_LOGGER_POST_FEEDBACK", "").lower() == "true",
            max_download_bytes=_positive_int(
                src, "SENSOR_LOGGER_MAX_DOWNLOAD_BYTES", MAX_DOWNLOAD_BYTES
            ),
            timeout_s=_positive_float(src, "SENSOR_LOGGER_HTTP_TIMEOUT_S", HTTP_TIMEOUT_S),
        )


class SidewalkClient:
    """Minimal client for the Sidewalk sync endpoints (worker bearer token)."""

    def __init__(self, config: SyncConfig, *, opener: Opener = study_opener) -> None:
        self._config = config
        self._opener = opener

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._config.api_base_url}{path}"
        request = urllib.request.Request(
            url,
            method="POST",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._config.worker_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener(request, timeout=self._config.timeout_s) as response:
                try:
                    raw = response.read().decode("utf-8") or "{}"
                except UnicodeDecodeError:
                    raise SyncError(f"{path} returned invalid UTF-8") from None
        except urllib.error.HTTPError as exc:
            raise SyncError(f"{path} failed: HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            reason = redact(str(exc.reason), self._config.worker_token, self._config.secret_code)
            raise SyncError(f"{path} failed: {reason}") from None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # A malformed response must not escape as an exception: it would end
            # the polling loop and abandon the rest of the leased batch.
            raise SyncError(f"{path} returned invalid JSON") from None
        if not isinstance(parsed, dict):
            raise SyncError(f"{path} returned {type(parsed).__name__}, expected an object")
        return parsed

    def claim(self, limit: int | None = None) -> list[dict[str, str]]:
        body = self._post(
            "/api/integrations/sensor-logger/jobs/claim",
            {"limit": limit or self._config.claim_limit},
        )
        uploads = body.get("uploads", [])
        if not isinstance(uploads, list):
            raise SyncError("claim response has no uploads array")
        return [u for u in uploads if isinstance(u, dict)]

    def complete(
        self,
        study_id: str,
        upload_id: str,
        *,
        scan: dict[str, Any] | None = None,
        bytes_downloaded: int | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"studyId": study_id, "uploadId": upload_id}
        if bytes_downloaded is not None:
            body["bytes"] = bytes_downloaded
        if scan is not None:
            body["scan"] = scan
        if error is not None:
            # Belt and braces: the caller already redacts, do it again here so no
            # code path can post a credential to the Sidewalk server.
            body["error"] = redact(error, self._config.secret_code, self._config.worker_token)[:1000]
        return self._post("/api/integrations/sensor-logger/jobs/complete", body)


def process_upload(
    study_id: str,
    upload_id: str,
    config: SyncConfig,
    client: SidewalkClient,
    *,
    opener: Opener = study_opener,
    threshold: float = 3.0,
) -> dict[str, Any]:
    """Download, scan and report one upload. Failures are reported, not raised."""
    with TemporaryDirectory(prefix="sensorlogger-") as tmp:
        archive = Path(tmp) / f"{upload_id}.zip"
        try:
            size = download_recording(
                study_id,
                upload_id,
                config.secret_code,
                archive,
                opener=opener,
                max_bytes=config.max_download_bytes,
                timeout=config.timeout_s,
            )
            recording = load_recording(archive)
            result, _ = scan_recording(recording, threshold=threshold)
        except (SyncError, OSError, ValueError, zipfile.BadZipFile) as exc:
            message = redact(f"{type(exc).__name__}: {exc}", config.secret_code, config.worker_token)
            outcome = {
                "studyId": study_id,
                "uploadId": upload_id,
                "status": "failed",
                "error": message,
            }
            try:
                client.complete(study_id, upload_id, error=message)
            except SyncError as report_exc:
                # The server could not record the failure, so the lease will
                # expire and the upload be retried. Other claimed uploads still
                # deserve their turn, so this is an outcome, not an exception.
                outcome["reportError"] = str(report_exc)
            return outcome

        try:
            response = client.complete(
                study_id, upload_id, scan=scan_payload(result), bytes_downloaded=size
            )
        except SyncError as exc:
            return {
                "studyId": study_id,
                "uploadId": upload_id,
                "status": "unreported",
                "bytes": size,
                "findings": len(result.findings),
                "quality": result.quality.verdict,
                "reportError": str(exc),
            }
        if config.send_feedback:
            try:
                post_feedback(
                    study_id,
                    upload_id,
                    config.secret_code,
                    feedback_markdown(result),
                    opener=opener,
                    timeout=config.timeout_s,
                )
            except SyncError as exc:
                # Feedback is a courtesy; the scan is already recorded.
                response = {**response, "feedbackError": str(exc)}
        return {
            "studyId": study_id,
            "uploadId": upload_id,
            "status": "done",
            "bytes": size,
            "findings": len(result.findings),
            "quality": result.quality.verdict,
            **{k: v for k, v in response.items() if k in ("reportCount", "feedbackError")},
        }


def sync_once(
    config: SyncConfig,
    *,
    client: SidewalkClient | None = None,
    opener: Opener = study_opener,
    threshold: float = 3.0,
) -> list[dict[str, Any]]:
    """Lease every currently pending upload batch and process it."""
    sidewalk = client or SidewalkClient(config, opener=opener)
    results: list[dict[str, Any]] = []
    for upload in sidewalk.claim():
        study_id, upload_id = upload.get("studyId"), upload.get("uploadId")
        if not study_id or not upload_id:
            continue
        results.append(
            process_upload(
                study_id, upload_id, config, sidewalk, opener=opener, threshold=threshold
            )
        )
    return results


def sync_forever(
    config: SyncConfig,
    interval_s: float,
    *,
    max_cycles: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    **kwargs: Any,
) -> Iterator[list[dict[str, Any]]]:
    """Poll the queue, yielding the outcome of each cycle."""
    cycle = 0
    while max_cycles is None or cycle < max_cycles:
        yield sync_once(config, **kwargs)
        cycle += 1
        if max_cycles is None or cycle < max_cycles:
            sleep(interval_s)
