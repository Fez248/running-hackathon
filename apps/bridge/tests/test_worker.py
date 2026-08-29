"""The HTTP scan worker: a raw upload becomes the same payload the CLI writes.

The web app's raw-upload path is only honest if this endpoint answers exactly
what `bridge scan --format map` writes, so these tests exercise the upload seam
(multipart parsing, layout reconstruction, traversal refusal) against a real
scan rather than a mock.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from bridge.experiments import ROUTE_ANOMALIES
from bridge.ingest import write_export_dir
from bridge.synth import SurfaceScenario, simulate_pass
from bridge.worker import (
    UploadedFile,
    materialise,
    parse_multipart,
    safe_relative_name,
    scan_upload,
)

BOUNDARY = "----bridgeboundary"


def multipart(files: list[tuple[str, bytes]]) -> tuple[str, bytes]:
    """A multipart body shaped the way the browser's FormData sends one."""
    chunks: list[bytes] = []
    for name, content in files:
        chunks.append(
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        chunks.append(content + b"\r\n")
    chunks.append(f"--{BOUNDARY}--\r\n".encode())
    return f"multipart/form-data; boundary={BOUNDARY}", b"".join(chunks)


def export_dir(tmp_path: Path) -> Path:
    scn = SurfaceScenario(seed=3, anomalies=list(ROUTE_ANOMALIES))
    trace, gps, _truth = simulate_pass(scn)
    write_export_dir(tmp_path / "rec", trace, gps)
    return tmp_path / "rec"


def uploaded_from(directory: Path, prefix: str) -> list[UploadedFile]:
    return [
        UploadedFile(name=f"{prefix}/{path.name}", content=path.read_bytes())
        for path in sorted(directory.iterdir())
    ]


def test_parse_multipart_keeps_the_relative_path_of_every_file():
    content_type, body = multipart(
        [("walk/Accelerometer.csv", b"a,b\n"), ("walk/Location.csv", b"c,d\n")]
    )
    files = parse_multipart(content_type, body)

    assert [file.name for file in files] == ["walk/Accelerometer.csv", "walk/Location.csv"]
    assert files[0].content == b"a,b\n"


def test_parse_multipart_rejects_a_body_with_no_recording_in_it():
    content_type = f"multipart/form-data; boundary={BOUNDARY}"
    body = f"--{BOUNDARY}--\r\n".encode()
    for bad in (
        lambda: parse_multipart("application/json", b"{}"),
        lambda: parse_multipart(content_type, body),
    ):
        try:
            bad()
        except ValueError:
            continue
        raise AssertionError("expected the worker to refuse that upload")


def test_safe_relative_name_refuses_traversal():
    assert safe_relative_name("../../etc/passwd") == "etc/passwd"
    assert safe_relative_name("/absolute/Location.csv") == "absolute/Location.csv"
    assert safe_relative_name("walk\\Gravity.csv") == "walk/Gravity.csv"
    assert safe_relative_name("..") == "recording.bin"


def test_materialise_points_at_the_exported_directory(tmp_path):
    files = [
        UploadedFile(name="walk/Accelerometer.csv", content=b"a\n"),
        UploadedFile(name="walk/Location.csv", content=b"b\n"),
    ]
    root = tmp_path / "root"
    root.mkdir()
    target = materialise(files, root)

    assert target == root / "walk"
    assert (target / "Accelerometer.csv").read_bytes() == b"a\n"


def test_materialise_points_at_a_single_archive(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    target = materialise([UploadedFile(name="walk.zip", content=b"PK")], root)
    assert target == root / "walk.zip"


def test_scan_upload_of_a_directory_export_answers_the_map_payload(tmp_path):
    payload = scan_upload(uploaded_from(export_dir(tmp_path), "walk"))

    assert set(payload) == {
        "source",
        "format",
        "quality",
        "cadenceSpm",
        "provenance",
        "findings",
        "clientScanId",
    }
    assert payload["quality"]["verdict"] in {"ok", "degraded", "unusable"}
    assert payload["findings"], "the seeded anomalous route has findings"
    assert payload["provenance"]["detectorThreshold"] == 3.0
    # The upload is scanned in a temporary directory that must not travel.
    assert str(tmp_path) not in json.dumps(payload)


def test_scan_upload_of_a_zip_matches_the_same_recording_as_a_directory(tmp_path):
    directory = export_dir(tmp_path)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for path in sorted(directory.iterdir()):
            zf.write(path, f"rec/{path.name}")

    from_zip = scan_upload([UploadedFile(name="rec.zip", content=buffer.getvalue())])
    from_dir = scan_upload(uploaded_from(directory, "rec"))

    assert from_zip["findings"] == from_dir["findings"]
    assert from_zip["quality"] == from_dir["quality"]
