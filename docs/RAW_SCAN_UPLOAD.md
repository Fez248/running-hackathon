# Raw recording upload

Recording a walk and getting its findings on the map used to be five steps, four
of them on a laptop: record, export, copy the file over, run the CLI, upload the
JSON. This is the shorter path — the scan panel takes the **raw Sensor Logger
export** (a `.zip`, or the unzipped folder) and the scan happens on the server —
plus the honest fallback for a deployment that cannot scan.

## Who scans

`apps/sidewalk` runs on Node. The detector is Python (`apps/bridge`), so the web
app can never scan a recording in-process. Raw upload therefore depends on a
**scan worker** reachable over HTTP, configured with `SCAN_WORKER_URL`.

The panel asks the server what it can do (`GET /api/scan/worker`) instead of
assuming:

| `SCAN_WORKER_URL` | What the panel offers |
| --- | --- |
| set | The recording is uploaded and scanned server-side; findings appear on the map without a laptop step. |
| unset | The panel says raw scanning is unavailable *here*, prints the exact CLI command with the picked recording's name already in it, and the JSON upload path stays as it was. |

Nothing pretends to scan. A worker that is configured but broken answers `502`,
and the panel then shows the same command as the fallback.

## Running the worker locally

The repository ships one, in the standard library, next to the detector:

```bash
(cd apps/bridge && uv run python -m bridge.worker --port 8787)
# then, for the web app:
SCAN_WORKER_URL="http://127.0.0.1:8787/scan" npm run dev
```

It binds loopback by default, scans each upload in a temporary directory that is
deleted afterwards, and returns exactly what `bridge scan --format map` writes.
Options: `--host`, `--port`, `--max-bytes`, `--threshold`.

## The worker contract

Any worker may be used; only this shape is required.

**Request** — `POST $SCAN_WORKER_URL`, `multipart/form-data`:

- one `file` part per file of the recording. Each part's `filename` carries the
  path relative to the recording root, so a directory upload keeps the layout
  `bridge.ingest.load_export_dir` expects. A single `.zip` part is the archive.
- `recording`: the name the user picked, for logs.
- `Authorization: Bearer $SCAN_WORKER_TOKEN` when a token is configured.

**Response** — `200` with the `bridge scan --format map` payload as JSON, bare
or wrapped as `{ "scan": … }`.

The web app validates that payload with `scanIngestSchema` before writing
anything, so a misbehaving worker cannot write what a hand upload could not, and
then ingests it through the same `scan.ingest` transaction: idempotent on
`clientScanId`, no reports from an `unusable` capture.

Size and time limits are the web app's, not the worker's:
`SCAN_WORKER_MAX_UPLOAD_BYTES` (default 64 MB, refused with `413` before the
body is read) and `SCAN_WORKER_TIMEOUT_MS` (default 120 s).

## Provenance

`SurfaceScan` stores the capture settings behind a finding: recorder app and
version, device model and platform, requested against measured sample rate, the
unit scale applied at ingest (1 for m/s², ~9.81 for a stream logged in g) and
the detector threshold. The scan panel shows them under "Capture settings".

Every column is nullable and the payload field is nullish: a scan from a bridge
build that predates the provenance block still ingests, as a scan whose settings
are honestly unknown.
