"""HTTP scan worker: a recording in, a map payload out.

``apps/sidewalk`` runs on Node and can never scan a recording itself, so the
web app's raw-upload path forwards the recording to whatever ``SCAN_WORKER_URL``
points at. This is that endpoint, kept to the standard library so running it is
one command next to the app::

    (cd apps/bridge && uv run python -m bridge.worker --port 8787)
    SCAN_WORKER_URL=http://127.0.0.1:8787/scan npm run dev

It accepts ``POST`` ``multipart/form-data`` with one ``file`` part per file of
the recording — the ``filename`` of each part carries the path relative to the
recording root, so a directory upload keeps the layout ``load_export_dir``
expects — and answers with exactly the JSON ``bridge scan --format map`` writes.
The scan happens in a temporary directory that is removed afterwards: the worker
holds no recording once it has answered.

Nothing here is trusted with a route on the public internet: it is a local
helper, so it binds loopback by default and refuses an upload larger than
``--max-bytes``.
"""

from __future__ import annotations

import argparse
import email.parser
import email.policy
import json
import tempfile
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .ingest import load_recording
from .scan import scan_recording, to_map_payload

DEFAULT_PORT = 8787
DEFAULT_MAX_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class UploadedFile:
    """One part of an uploaded recording."""

    #: Path relative to the recording root, already checked for traversal.
    name: str
    content: bytes


def parse_field(content_type: str, body: bytes, name: str) -> str | None:
    """A named text field of a multipart body, if it carries one."""
    for part in _parts(content_type, body):
        if part.get_param("name", header="content-disposition") != name:
            continue
        if part.get_filename():
            continue
        payload = part.get_payload(decode=True)
        if payload:
            return payload.decode("utf-8", "replace").strip() or None
    return None


def parse_multipart(content_type: str, body: bytes) -> list[UploadedFile]:
    """The ``file`` parts of a multipart body, in order."""
    files: list[UploadedFile] = []
    for part in _parts(content_type, body):
        if part.get_param("name", header="content-disposition") != "file":
            continue
        filename = part.get_filename() or "recording.bin"
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        files.append(UploadedFile(name=safe_relative_name(filename), content=payload))
    if not files:
        raise ValueError("no file part in the upload")
    return files


def _parts(content_type: str, body: bytes):
    """The parts of a multipart body.

    ``cgi`` is gone from the standard library, so the body is handed to the
    email parser, which is what is left that understands MIME multipart.
    """
    if "multipart/form-data" not in content_type.lower():
        raise ValueError("expected multipart/form-data")
    headers = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(headers + body)
    if not message.is_multipart():
        raise ValueError("body is not multipart")
    return message.iter_parts()


def safe_relative_name(filename: str) -> str:
    """A relative path an upload cannot use to escape the scan directory."""
    parts = [
        part
        for part in Path(filename.replace("\\", "/")).parts
        if part not in ("", ".", "..", "/")
    ]
    return "/".join(parts) or "recording.bin"


def materialise(files: list[UploadedFile], root: Path, recording: str | None = None) -> Path:
    """Write the upload under ``root`` and return what to scan.

    A single ``.zip`` is scanned as the archive it is; anything else is a
    directory export, and its own top-level folder (which the browser includes
    in every relative path) is what the CLI would have been pointed at.

    A browser that sends no directory component gets one: the scan target's name
    ends up in the payload's ``source`` and in the content-addressed scan id, so
    scanning under this request's random temporary directory would make every
    re-upload of one recording a different scan.
    """
    flat = all("/" not in file.name for file in files)
    prefix = safe_relative_name(recording or "") if recording else ""
    if flat and len(files) > 1 and prefix:
        files = [UploadedFile(name=f"{prefix}/{file.name}", content=file.content) for file in files]

    for file in files:
        target = root / file.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(file.content)

    if len(files) == 1 and files[0].name.lower().endswith(".zip"):
        return root / files[0].name

    entries = list(root.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return root


def scan_upload(
    files: list[UploadedFile], threshold: float = 3.0, recording: str | None = None
) -> dict:
    """Scan an uploaded recording and return the map payload for it."""
    with tempfile.TemporaryDirectory(prefix="bridge-worker-") as tmp:
        target = materialise(files, Path(tmp), recording)
        loaded = load_recording(target)
        result, _pass = scan_recording(loaded, threshold=threshold)
        return to_map_payload(result)


class ScanRequestHandler(BaseHTTPRequestHandler):
    """One route, ``POST /scan``, plus ``GET /health`` so a caller can probe."""

    server_version = "bridge-scan-worker"
    max_bytes: int = DEFAULT_MAX_BYTES
    threshold: float = 3.0

    def _json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        if self.path.rstrip("/") in ("/health", ""):
            self._json(200, {"status": "ok", "maxBytes": self.max_bytes})
            return
        self._json(404, {"error": "not-found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        if self.path.rstrip("/") not in ("/scan", ""):
            self._json(404, {"error": "not-found"})
            return

        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            self._json(400, {"error": "empty-upload"})
            return
        if length > self.max_bytes:
            self._json(413, {"error": "upload-too-large", "maxBytes": self.max_bytes})
            return

        body = self.rfile.read(length)
        try:
            files = parse_multipart(self.headers.get("content-type", ""), body)
        except ValueError as error:
            self._json(400, {"error": "invalid-upload", "message": str(error)})
            return

        try:
            recording = parse_field(self.headers.get("content-type", ""), body, "recording")
            payload = scan_upload(files, threshold=self.threshold, recording=recording)
        except Exception as error:  # a bad recording must not kill the worker
            self._json(422, {"error": "scan-failed", "message": str(error)})
            return
        self._json(200, payload)


def serve(host: str, port: int, max_bytes: int, threshold: float) -> None:
    handler = type(
        "BoundScanRequestHandler",
        (ScanRequestHandler,),
        {"max_bytes": max_bytes, "threshold": threshold},
    )
    with ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"scan worker listening on http://{host}:{port}/scan")
        httpd.serve_forever()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HTTP scan worker for the Sidewalk Map web app")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default loopback)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--threshold", type=float, default=3.0, help="detector robust-z threshold")
    args = parser.parse_args(argv)
    serve(args.host, args.port, args.max_bytes, args.threshold)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
