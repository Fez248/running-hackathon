# Sensor Logger Studies → Sidewalk Map automatic sync

Participants record with [Sensor Logger](https://sensorlogger.app/) and upload to a **Study**.
Sensor Logger Cloud then calls a webhook on this app once per uploaded recording; the recording is
downloaded server-side, scanned by the existing `apps/bridge` pipeline, and its findings become
`ROUGH_SURFACE` reports on the map. No file handling by hand, no CLI run per recording.

Research basis (upstream, authoritative):

- Study webhooks: <https://github.com/tszheichoi/awesome-sensor-logger/blob/main/STUDY_WEBHOOKS.md>
- Study API: <https://github.com/tszheichoi/awesome-sensor-logger/blob/main/STUDY_API.md>
- Sensor Logger: <https://sensorlogger.app/>

Upstream contract in one paragraph: on each upload, Sensor Logger POSTs
`{"studyId": "...", "uploadId": "...", "secretCode": "..."}` to the Study's webhook URL. The
recording zip is fetched with `GET https://sensorlogger.app/api/study/file/v1?studyId=…&uploadId=…`
and `Authorization: {secretCode}`. Markdown or PDF feedback can be posted back to the participant at
`POST https://sensorlogger.app/api/study/webhook/v1?studyId=…&uploadId=…`.

## Architecture

The scan is NumPy/SciPy Python; the web app is Node on Vercel. A Vercel route handler therefore
cannot run the pipeline, and the webhook must answer fast because Sensor Logger calls it **once**
per upload. So the flow is split at the database:

```
Sensor Logger Cloud                Sidewalk (Next.js / Vercel)              bridge worker (Python)
────────────────────               ───────────────────────────              ──────────────────────
upload finished
  └─ POST /webhook  ───────────▶   authenticate secretCode
     {studyId,uploadId,secret}     dedupe (studyId, uploadId)
                                   SensorLoggerUpload = PENDING
                                   200 {status: queued|duplicate}
                                                                   ◀─────── POST /jobs/claim  (bearer)
                                   lease N rows → CLAIMED           ──────▶ {uploads:[{studyId,uploadId}]}
GET /api/study/file/v1   ◀──────────────────────────────────────────────── download zip (Authorization: secret)
  (zip)                  ─────────────────────────────────────────────────▶ ingest → quality → scan
                                                                   ◀─────── POST /jobs/complete (bearer)
                                   scanToReports() → Report rows            {studyId,uploadId,bytes,scan|error}
                                   upload = DONE | FAILED
POST /api/study/webhook/v1 ◀─────────────────────────────────────────────── optional Markdown feedback
```

The webhook does exactly two things — authenticate and record the upload — so the request Sensor
Logger cannot retry is never lost to a slow download or a failing scan.

### Code map

| Concern | File |
| --- | --- |
| Payload/auth/mapping contracts (pure, client-safe) | `libs/core/src/sensor-logger.ts` |
| HTTP handlers (`Request` → `Response`, no framework) | `libs/api/src/integrations/sensor-logger.ts` |
| Prisma queue + report writer | `libs/api/src/integrations/sensor-logger-store.ts` |
| Route mounts | `apps/sidewalk/src/app/api/integrations/sensor-logger/**/route.ts` |
| Queue row | `SensorLoggerUpload` in `libs/db/prisma/schema.prisma` |
| Worker (download → scan → report → feedback) | `apps/bridge/src/bridge/sensorlogger.py`, `bridge sync` |

`SensorLoggerUploadStore` in the handler module is the adapter boundary: the default implementation
is the Prisma table, and a real queue (Vercel Queues, SQS, QStash) can replace it by implementing
`enqueue` / `claim` / `complete` without touching the handlers or the worker protocol.

## Endpoints

### `POST /api/integrations/sensor-logger/webhook`

Called by Sensor Logger Cloud. Auth: the Study `secretCode` **in the body** (that is all Sensor
Logger sends), compared against `SENSOR_LOGGER_SECRET_CODE` in constant time.

Request:

```json
{ "studyId": "st_123", "uploadId": "up_456", "secretCode": "…" }
```

Responses:

| Status | Body | When |
| --- | --- | --- |
| 200 | `{"status":"queued","uploadKey":"st_123/up_456","jobStatus":"PENDING"}` | accepted |
| 200 | `{"status":"duplicate","uploadKey":"…","jobStatus":"PENDING"}` | replay of a known upload |
| 400 | `{"error":"invalid-json"}` / `{"error":"invalid-payload"}` | unparseable or malformed body |
| 401 | `{"error":"unauthorized"}` | wrong secret, or study not in the allowlist |
| 413 | `{"error":"payload-too-large"}` | body over 8 KiB |
| 503 | `{"error":"integration-not-configured"}` | `SENSOR_LOGGER_SECRET_CODE` unset |

Anything that is *our* fault (unconfigured, database down) answers 5xx, so Sensor Logger's
connectivity test and the operator both see a server problem rather than a silent drop. Nothing from
the unvalidated body is ever echoed, because it may contain the secret.

### `POST /api/integrations/sensor-logger/jobs/claim`

Worker-only. Auth: `Authorization: Bearer $SENSOR_LOGGER_WORKER_TOKEN` (a token of ours, *not* the
Study secret — the worker must never present a Sensor Logger credential to this app).

Request `{"limit": 5}` (1–25, default 5; empty body allowed). Response
`200 {"uploads":[{"studyId":"st_123","uploadId":"up_456","attempts":1}]}`.

Leases are exclusive: rows move `PENDING → CLAIMED` under an optimistic `updatedAt` check, so two
workers never get the same upload. A lease older than `SENSOR_LOGGER_CLAIM_TIMEOUT_MS` (default
15 min) is reclaimed — a worker that dies mid-download does not strand the recording — and an upload
that fails `SENSOR_LOGGER_MAX_ATTEMPTS` times (default 5) stops being handed out.

### `POST /api/integrations/sensor-logger/jobs/complete`

Worker-only, same bearer token. Body carries either a scan result or a redacted error:

```json
{
  "studyId": "st_123",
  "uploadId": "up_456",
  "bytes": 8123456,
  "scan": {
    "format": "sensorlogger",
    "quality": { "verdict": "ok", "usable": true, "reasons": [] },
    "cadence_spm": 152.4,
    "n_windows": 412,
    "n_footfalls": 690,
    "findings": [
      {
        "index": 0,
        "kind": "loose_or_broken_element",
        "description": "rattling slab or loose cover",
        "start_m": 78.0, "end_m": 90.0, "peak_m": 84.0,
        "score": 4.7, "confidence": 0.82,
        "lat": 51.5001, "lon": -0.124
      }
    ],
    "notes": []
  }
}
```

Responses: `200 {"status":"done","findingCount":1,"reportCount":1,"quality":"ok"}`,
`200 {"status":"failed"}` for the error form, `400 invalid-json|invalid-payload`,
`401 unauthorized`, `404 {"error":"unknown-upload"}`, `413 payload-too-large` (over 512 KiB),
`503 integration-not-configured`.

A completion is matched against the upload queue *before* anything is written, so a scan for an
upload the webhook never queued is refused without touching the map. When the worker cannot reach
this endpoint it emits `{"status":"unreported","reportError":...}` for that upload and carries on
with the rest of the batch; the lease then expires and the upload is handed out again.

## Data mapping

`scanToReports()` (`libs/core`) turns a scan into the existing `createReportSchema` shape, so sensor
reports live in the same `Report` table, map layer, voting and confidence machinery as manual and
voice reports:

- **Withheld entirely** when `quality.usable` is false. A capture below 100 Hz, under 30 s, without
  gravity or with poor GPS cannot support a claim about the pavement, and a wrong pin is worse than
  no pin. The bridge quality gate already decides this (`apps/bridge/src/bridge/quality.py`).
- **Withheld per finding** when the finding has no `lat`/`lon` — an unlocated obstacle is not mappable.
- `kind`: `ROUGH_SURFACE` (the one obstacle kind the IMU actually evidences).
- `passability`: `DIFFICULT` for a `loose_or_broken_element` at confidence ≥ 0.6, else `UNKNOWN`.
  Sensor findings are advisory; they never assert `BLOCKED`.
- `source`: `SENSOR` — a new value alongside `MANUAL` and `VOICE`, so the UI and stats can tell
  automated observations from human ones.
- `note`: the finding description, distance along the route, robust-z score, and a
  "degraded capture" marker when the quality gate warned.
- `clientReportId`: `sl:<studyId>:<uploadId>:<index>`, or `sl:<fnv1a64 hex>:<index>` when that would
  exceed the 64-character column. `report.create` upserts on this key, so a worker that retries
  after a timeout updates its pins instead of duplicating them. `sl:` is a reserved namespace: the
  `report.create`/`createMany`/`createFromVoice` procedures reject a client-supplied
  `clientReportId` with that prefix, so an app client cannot occupy a row a later scan will write.
  `source: 'SENSOR'` is server-owned in the same way: `report.create`/`createMany` reject it, so
  only the integration's own writer can mark a pin as measured.

## Secret handling

`secretCode` is a Study-wide credential: it can download every recording in the study. Therefore:

- It is **never persisted**. The `SensorLoggerUpload` model has no column for it, by design.
- It is **never logged or echoed**: the webhook responds with fixed error codes, and no handler
  serialises the request body.
- It is compared in constant time (`secretCodeMatches`), so a wrong secret leaks no timing signal.
- The worker reads its own copy from `SENSOR_LOGGER_SECRET_CODE` and sends it only as an
  `Authorization` header to `https://sensorlogger.app`. Every message the worker produces goes
  through `redact()`, and `SidewalkClient.complete()` redacts again before posting, so no code path
  can send a credential to the Sidewalk server. This is asserted by tests.
- Rotation: change the Study secret in Sensor Logger, then update `SENSOR_LOGGER_SECRET_CODE` on
  both the web app and the worker. Uploads webhooked in between will be rejected with 401 and must
  be re-uploaded — rotate when the study is idle.

## Limits, replay and network safety

| Guard | Value | Where |
| --- | --- | --- |
| Webhook body | 8 KiB (`Content-Length` and decoded length) | `MAX_WEBHOOK_BODY_BYTES` |
| Completion body | 512 KiB, ≤ 500 findings | `MAX_COMPLETION_BODY_BYTES`, `bridgeScanResultSchema` |
| Id shape | `[A-Za-z0-9._:-]{1,128}` | `identifierSchema` |
| Download size | 256 MiB, streamed, aborted mid-transfer when exceeded | `MAX_DOWNLOAD_BYTES` |
| HTTP timeout (worker) | 120 s | `HTTP_TIMEOUT_S` |
| Archive/CSV size after download | existing ingest caps, zip-slip rejection | `apps/bridge/src/bridge/ingest.py` |
| Lease timeout / attempts | 15 min / 5 | `SENSOR_LOGGER_CLAIM_TIMEOUT_MS`, `SENSOR_LOGGER_MAX_ATTEMPTS` |

**Replay/idempotency.** `@@unique([studyId, uploadId])` makes the webhook idempotent: a replayed
call answers `duplicate` and enqueues nothing, whatever the job's current state. Report ids are
deterministic, so a replayed *scan* rewrites the same pins. A replayed webhook with a *wrong* secret
is rejected before it touches the database.

**SSRF.** The webhook payload never supplies a URL. The Study API origin is a constant, the two ids
are URL-encoded into the query string, and the worker re-checks scheme+host before every call
(`_require_study_origin`), so a hostile `uploadId` can neither escape the path nor redirect the
request. Redirects are refused outright rather than followed (`study_opener`): a 3xx would otherwise
replay the `Authorization` header against whatever host it names, so a redirect surfaces as a failed
download instead.
The downloaded zip is treated as untrusted input by the existing ingest code: entries that escape the
extraction directory are rejected, and per-file sizes are capped.

**Failure isolation.** A download, unzip or scan failure marks that upload `FAILED` with a redacted
reason; it never crashes the worker or blocks the rest of the batch. Feedback POST failures are
recorded but do not undo a successfully recorded scan.

## Configuration

Web app (Vercel project env, all environments that receive webhooks):

| Variable | Required | Meaning |
| --- | --- | --- |
| `SENSOR_LOGGER_SECRET_CODE` | yes | Study secret code; absent ⇒ webhook answers 503 (fail closed) |
| `SENSOR_LOGGER_WORKER_TOKEN` | yes | Bearer token for `/jobs/*`; generate with `openssl rand -hex 32` |
| `SENSOR_LOGGER_STUDY_IDS` | no | Comma-separated allowlist of `studyId`s |
| `SENSOR_LOGGER_CLAIM_TIMEOUT_MS` | no | Lease timeout, default `900000` |
| `SENSOR_LOGGER_MAX_ATTEMPTS` | no | Attempts before an upload is abandoned, default `5` |

Worker (wherever the Python pipeline runs):

| Variable | Required | Meaning |
| --- | --- | --- |
| `SIDEWALK_API_URL` | yes | e.g. `https://sidewalk.example.com`; https only (plain http is accepted for `localhost` alone, since every call carries the worker token) |
| `SENSOR_LOGGER_WORKER_TOKEN` | yes | must match the web app |
| `SENSOR_LOGGER_SECRET_CODE` | yes | Study secret, for the Study API download |
| `SENSOR_LOGGER_POST_FEEDBACK` | no | `true` to post a Markdown report back to the participant |
| `SENSOR_LOGGER_CLAIM_LIMIT` | no | uploads per cycle, default 5, 1-25 |
| `SENSOR_LOGGER_MAX_DOWNLOAD_BYTES` | no | default 268435456 |
| `SENSOR_LOGGER_HTTP_TIMEOUT_S` | no | default 120 |

Every numeric variable must be a positive number within its documented range; anything else fails
startup with `error: <VARIABLE> ...` and exit code 2 rather than a traceback.

Never commit these; use `vercel env add` and the worker host's secret store.

## Sensor Logger Study setup

1. Create a Study in the Sensor Logger app (Studies → new study) and note its `studyId` and secret
   code.
2. Set the Study's webhook URL to
   `https://<your-app>/api/integrations/sensor-logger/webhook`.
3. Choose the webhook mode: **Notify** (fire-and-forget) is enough for mapping; **Notify & Respond**
   additionally shows the Markdown report this worker can post back — enable
   `SENSOR_LOGGER_POST_FEEDBACK=true` for that.
4. Put the secret code into `SENSOR_LOGGER_SECRET_CODE` on the web app *and* the worker, and add the
   `studyId` to `SENSOR_LOGGER_STUDY_IDS` if you allowlist.
5. Use Sensor Logger's webhook connectivity test; it must return 200. A 401 means the secret differs,
   a 503 means the app has no secret configured.
6. Tell participants the capture requirements the quality gate enforces: ≥ 100 Hz IMU
   (Sensor Logger sampling rate 100–200 Hz), total acceleration **and** location enabled, ≥ 30 s of
   continuous walking, phone carried steadily. See `apps/bridge/docs/REAL_WORLD_TEST.md`.

## Local testing

```bash
# 1. Web app with the integration configured (never commit these values).
export SENSOR_LOGGER_SECRET_CODE=dev-secret
export SENSOR_LOGGER_WORKER_TOKEN=dev-worker-token
npm run db:push        # creates the SensorLoggerUpload table locally
npm run dev -w @sidewalk/web

# 2. Simulate the Sensor Logger webhook.
curl -sS -X POST http://localhost:3000/api/integrations/sensor-logger/webhook \
  -H 'content-type: application/json' \
  -d '{"studyId":"st_dev","uploadId":"up_1","secretCode":"dev-secret"}'
# {"status":"queued","uploadKey":"st_dev/up_1","jobStatus":"PENDING"}

# Replay -> duplicate, wrong secret -> 401, junk -> 400.
curl -sS -X POST http://localhost:3000/api/integrations/sensor-logger/webhook \
  -H 'content-type: application/json' \
  -d '{"studyId":"st_dev","uploadId":"up_1","secretCode":"dev-secret"}'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:3000/api/integrations/sensor-logger/webhook \
  -H 'content-type: application/json' \
  -d '{"studyId":"st_dev","uploadId":"up_2","secretCode":"wrong"}'

# 3. Worker side: lease the pending upload.
curl -sS -X POST http://localhost:3000/api/integrations/sensor-logger/jobs/claim \
  -H 'authorization: Bearer dev-worker-token' \
  -H 'content-type: application/json' -d '{"limit":5}'

# 4. Report a scan without touching the Study API (a real bridge scan JSON works too).
curl -sS -X POST http://localhost:3000/api/integrations/sensor-logger/jobs/complete \
  -H 'authorization: Bearer dev-worker-token' \
  -H 'content-type: application/json' \
  -d '{"studyId":"st_dev","uploadId":"up_1","bytes":1024,
       "scan":{"format":"sensorlogger",
               "quality":{"verdict":"ok","usable":true,"reasons":[]},
               "cadence_spm":150,"n_windows":10,"n_footfalls":20,
               "findings":[{"index":0,"kind":"loose_or_broken_element",
                            "description":"rattling slab","start_m":10,"end_m":20,
                            "peak_m":15,"score":4.2,"confidence":0.8,
                            "lat":51.5001,"lon":-0.124}],
               "notes":[]}}'
# {"status":"done","findingCount":1,"reportCount":1,"quality":"ok"} -> pin appears on the map
```

Real end-to-end run against a live Study, from `apps/bridge`:

```bash
export SIDEWALK_API_URL=http://localhost:3000
export SENSOR_LOGGER_WORKER_TOKEN=dev-worker-token
export SENSOR_LOGGER_SECRET_CODE=<study secret>
python -m bridge.cli sync                     # one cycle, one JSON line per upload
python -m bridge.cli sync --poll 60           # keep polling every 60 s
```

`bridge sync` exits 0 when every upload succeeded, 1 when any upload failed, 2 on a configuration
error.

## Deployment

**Vercel.** The three route handlers are `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`; they
do no long work, so the default function limits are ample. The webhook must be reachable
unauthenticated by Sensor Logger — if Vercel Deployment Protection is on for the target environment,
add a protection bypass for `/api/integrations/sensor-logger/webhook`, or Sensor Logger sees a
challenge page instead of the handler. Preview deployments each have their own URL, so point the
Study at production and test previews with curl.

**Turso / libSQL.** The `SensorLoggerUpload` model is additive; apply it with `npm run db:push`
(local SQLite) or `prisma db push` against `DATABASE_URL`/`TURSO_AUTH_TOKEN` for Turso. The claim
path is a `SELECT` plus a guarded `updateMany`, which is safe on libSQL without transactions because
the update is conditional on `updatedAt`; it does not rely on `SELECT … FOR UPDATE`, which libSQL
lacks. Nothing else in the schema changes, and no existing table is migrated.

**The worker is not serverless.** It needs NumPy/SciPy and minutes of CPU per recording, so it runs
outside Vercel: a laptop for a hackathon demo, or `bridge sync --poll 60` under systemd/a container
for continuous operation. Cron-invoking it from Vercel is not possible; a Vercel Cron job can only
poke a Node endpoint, which cannot run the pipeline. If uploads must be processed within seconds,
replace the polling loop with a real queue behind `SensorLoggerUploadStore`.

## Monitoring

`SensorLoggerUpload` is the operational surface — every row carries `status`, `attempts`,
`receivedAt`, `claimedAt`, `completedAt`, `bytes`, `findingCount`, `reportCount`, `quality` and a
redacted `error`:

```sql
-- backlog and health
SELECT status, COUNT(*) FROM SensorLoggerUpload GROUP BY status;
-- stuck leases (worker died or is slow)
SELECT studyId, uploadId, attempts, claimedAt FROM SensorLoggerUpload
 WHERE status = 'CLAIMED' AND claimedAt < datetime('now', '-15 minutes');
-- recordings the quality gate refused (a capture-instructions problem, not a bug)
SELECT quality, COUNT(*) FROM SensorLoggerUpload WHERE status = 'DONE' GROUP BY quality;
-- recent failures, reasons are pre-redacted
SELECT studyId, uploadId, attempts, error FROM SensorLoggerUpload
 WHERE status = 'FAILED' ORDER BY updatedAt DESC LIMIT 20;
```

Worth alerting on: `PENDING` older than an hour (worker down), any `CLAIMED` past the lease timeout,
a rising `FAILED` count, and `DONE` rows with `findingCount > 0` but `reportCount = 0` (findings
arriving without GPS). A 401 spike on the webhook means a stale secret somewhere; a 503 means the
deployment lost its configuration.

## Tests

- `libs/core/src/sensor-logger.test.ts` — payload validation, redaction, constant-time secret
  comparison, fail-closed auth, study allowlist, deterministic report ids (including the 64-char
  column bound), scan parsing, and the mapping rules (unusable capture ⇒ no reports).
- `libs/api/src/integrations/sensor-logger.test.ts` — env parsing, queueing, replay, wrong secret,
  unconfigured 503, oversized/malformed bodies, worker token auth, bounded and non-overlapping
  claims, scan→report completion, failure recording, unknown upload.
- `apps/bridge/tests/test_sensorlogger.py` — URL construction and id encoding, `Authorization`
  header, size limits (declared and streamed), redacted download errors, the completion payload
  shape, feedback Markdown, the full download→scan→report loop against a synthetic recording, and
  assertions that the Study secret never appears in Sidewalk-bound traffic.

Run: `npm test` and `(cd apps/bridge && python -m pytest -q)`.
