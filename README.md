# running-hackathon

Monorepo for **Sidewalk Map** — a crowdsourced map of curbs, steps, roadworks and passable
crossings for wheelchair users, stroller users, couriers and delivery robots, collected by runners
and riders while they move.

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for scope, data model, API surface and next
steps.

## Layout

| Path | Package | What |
| --- | --- | --- |
| `apps/sidewalk` | `@sidewalk/web` | Next.js 15 App Router UI + tRPC endpoint |
| `libs/core` | `@sidewalk/core` | Domain enums, zod schemas, geo + passability/confidence logic |
| `libs/db` | `@sidewalk/db` | Prisma schema (SQLite), client singleton, seed |
| `libs/api` | `@sidewalk/api` | tRPC context and routers |
| `apps/bridge` | `bridge` (Python) | Feet-as-a-sensor-network prototype: phone IMU + GPS → floor imperfections |
| `libs/imukit` | `imukit` (Python) | Shared IMU/GPS primitives used by `apps/bridge` |

Libraries are shipped as TypeScript source and compiled by the consuming app
(`transpilePackages`), so a second app in `apps/` reuses them by adding a workspace dependency.

## Quick start

```bash
npm install
npm run env:init      # creates the single repo-root .env from .env.example
npm run db:generate && npm run db:push && npm run db:seed
npm run dev            # http://localhost:3000
```

Or: `npm run setup && npm run dev`.

Configuration lives in one place: the repository-root `.env`. Prisma CLI commands load it through
`dotenv-cli`, and at runtime `libs/db` walks up from the current working directory to find it, so
`DATABASE_URL` resolves identically for the dev server, the production server and one-off scripts,
whatever directory they start in. `file:./dev.db` is relative to `libs/db/prisma/schema.prisma`,
i.e. `libs/db/prisma/dev.db`.

The seed appends, so re-seeding a populated database duplicates rows — use `npm run db:reset`
(force-reset the schema, then seed) to get back to the 8-report fixture. Run it after pulling schema
changes too, since `dev.db` is created with `db push` rather than migrations.

Prisma commands print `Your schema specifies the following datasource properties but you are using a
Driver Adapter [...] The values from your schema will NOT be used!`. That is informational: the
schema's `url` is a placeholder Prisma requires for validation, and the effective database is the one
`DATABASE_URL` names. `prisma migrate` is the exception — its schema engine cannot use the libSQL
adapter, so migrations always run against the schema's `libs/db/prisma/dev.db`.

## Detecting floor imperfections from a phone recording

`apps/bridge` turns an ordinary phone IMU + GPS recording into geo-located surface
findings (loose slabs, mats, wet patches, loose boards) that feed the Sidewalk Map as
`ROUGH_SURFACE` points.

```bash
cd apps/bridge
pip install -e ../../libs/imukit -e '.[dev]'
python -m bridge.cli scan --demo                 # no hardware needed
python -m bridge.cli scan ~/Downloads/run.zip --out found.geojson --format geojson
```

Recording a real pass — logging apps, the ≥100 Hz / ≤3 m GPS / gravity-included
acceptance checks, and how to read the output — is in
[apps/bridge/docs/REAL_WORLD_TEST.md](./apps/bridge/docs/REAL_WORLD_TEST.md).

## Turso / deployment

The same Prisma schema runs on a local SQLite file and on a remote libSQL database (Turso). When
`DATABASE_URL` uses a remote scheme (`libsql://`, `https://`, `wss://`), `libs/db` builds the client
on top of `@prisma/adapter-libsql` and needs `TURSO_AUTH_TOKEN`; a `file:` URL keeps the built-in
SQLite connector. `libs/db/prisma.config.ts` wires the same adapter into the Prisma CLI, so
`db:push`, `db:seed` and `db:studio` target Turso with no extra flags.

Deploying to Vercel: root directory `apps/sidewalk` (npm workspaces are installed from the repo
root), `prisma generate` runs from the app's `prebuild` script, and the project needs `DATABASE_URL`
plus `TURSO_AUTH_TOKEN` set for Production, Preview and Development. Push the schema once per
database with `npm run db:push`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Next dev server for `apps/sidewalk` |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | Vitest unit tests (`libs/core`) |
| `npm run db:push` / `db:seed` / `db:studio` | Prisma against `libs/db/prisma/dev.db` |
| `npm run db:reset` | Drop and recreate the database, then re-seed |

## Fog of War runs

Streets nobody has surveyed stay under a fog overlay. Press **Start run** in the sidebar and the
app watches your position with `navigator.geolocation.watchPosition(..., { enableHighAccuracy: true,
maximumAge: 0 })`, clearing a ~25 m radius of fog around every fix it accepts. Coverage is stored as
grid cells (`CoverageCell`), so reloading the page keeps everything you have explored, and a `Trace`
is opened at run start and closed with the full path when you stop.

Fixes pass through the filter in `libs/core/src/gps.ts` before they touch the map, because raw
browser fixes drift badly in cities:

| Guard | Default | Why |
| --- | --- | --- |
| `maxAccuracyM` | 30 m | A ±100 m Wi-Fi fix would clear a whole neighbourhood |
| `maxSpeedMps` | 12 m/s | Rejects teleports between cell-tower fixes |
| `minDistanceM` | 4 m | Suppresses standing-still jitter |

Accepted coordinates are smoothed with a weight derived from the reported accuracy, and fog is
cleared locally the moment a fix is accepted — the `coverage.reveal` call is batched every 3 s or
8 points, so the overlay never waits for the network.

### Voice reporting

With a run active you can enable **Ambient voice reporting** and just say what you see ("dropped
curb on the left, about fifteen centimetres"). Transcripts come from the Web Speech API
(`SpeechRecognition`, `continuous` + `interimResults`); each final utterance is parsed into an
obstacle kind, passability and measurements by `libs/core/src/voice.ts`, geocoded to the latest
accepted GPS fix and saved as a report with `source: 'VOICE'` plus the raw transcript. The parser is
deliberately conservative: an utterance that names no sidewalk feature is ignored rather than
becoming a marker.

Privacy and support notes, surfaced in the UI as well:

- The microphone only runs while you explicitly enable it, and stops when the run stops.
- Chrome's implementation may send audio to a server-side recognition service, so dictation is not
  local-only. The button is opt-in for that reason.
- `SpeechRecognition` is not Baseline: Chrome and Safari support it, Firefox does not. Where it is
  missing — or the microphone is denied — the panel falls back to a text field that runs the same
  parser.

### Known limitations

- Reports need a live run: typed and dictated reports are refused unless a run is active and has an
  accepted fix, so a marker can never land on the previous run's last position.
- Closing the tab mid-run is best effort. Leaving the map stops the run and tries to flush the last
  fixes and close the trace, but a browser can discard in-flight requests on unload; fog already
  confirmed by `coverage.reveal` survives, at worst the final few seconds of a path do not.
- `coverage.reveal`, `trace.start` and `trace.finish` are public procedures with no ownership check,
  matching the scaffold's anonymous reporting model — they would need auth before a public deploy.
- `coverage.summary` derives explored area from the mean latitude of all cells rather than summing
  per-cell areas.

### Platform findings

- [MDN — `Geolocation.watchPosition()`](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition)
  and [`PositionOptions`](https://developer.mozilla.org/en-US/docs/Web/API/PositionOptions):
  `enableHighAccuracy` requests the most precise fix available at a battery cost, `maximumAge: 0`
  forbids cached fixes. The watch is cleared on stop/unmount for that reason.
- [MDN — Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) documents
  the limited cross-browser support and the server-based recognition caveat above.
- Native iOS equivalent (not implemented here): CoreLocation's
  [`kCLLocationAccuracyBestForNavigation`](https://developer.apple.com/documentation/corelocation/kcllocationaccuracybestfornavigation)
  with `CLLocationUpdate.liveUpdates` is the direct counterpart of the browser watch, and would
  additionally allow background updates a web app cannot get.

## Fleet passability API

Routing engines do not want the map's reports, they want a verdict per waypoint. `public.passability`
answers "can this profile get through here?" for one point, `public.passabilityBatch` for a whole
route leg (≤ 50 waypoints, normally two queries in total). Both are tRPC queries, so reachable over
plain HTTP GET:

```bash
curl -sG http://localhost:3000/api/trpc/public.passability \
  --data-urlencode 'input={"json":{"lat":52.5200,"lng":13.4050,"radiusM":40,"profile":"WHEELCHAIR"}}'
```

Each waypoint comes back as `{ lat, lng, verdict, confidence, sampleSize, lastCapturedAt, surveyed }`
and nothing else — no transcripts, contributor identities, report ids or traces leave the map, and
every procedure in the router is read-only.

How the verdict is reached (`libs/core/src/passability.ts`):

- Every report within the radius is weighted by its own confidence × freshness × proximity — full
  weight for the first 30 days, decaying to 0.35 by 180 days, halved at the edge of the radius.
- Observations under the 0.25 trust floor are ignored so one unconfirmed report with poor GPS cannot
  close a street for a fleet; they still count towards `sampleSize`.
- The worst remaining verdict wins, evaluated **per profile**: a 5 cm kerb is `PASSABLE` for a
  `COURIER` and `DIFFICULT` for a `WHEELCHAIR`, via the same `passabilityForProfile` rules the map uses.
  A report whose author did not judge passability does not compete in that comparison — it is not
  evidence against the street — but its measurements still can rule the street out for a profile.
- `surveyed` separates the two kinds of `UNKNOWN`: `surveyed: true` means someone walked here (a
  report or revealed fog) and flagged nothing, `surveyed: false` means the map has never seen the
  place. A planner should treat only the second as a blind spot. A resolved or rejected report no
  longer says anything about passability, but it still proves someone was here, so it keeps counting
  towards `surveyed` while staying out of the verdict.

`radiusM` is capped at 200 m per waypoint, so no single call can scan a city. A leg is read with one
query per table while that read stays under its row cap; if a dense stretch fills it, each waypoint is
re-read against its own radius and paged to the end, so a busy neighbourhood cannot starve the
waypoints after it and no row inside a radius is dropped before the distance filter runs. Those
per-waypoint reads run one after another and are shared between repeated waypoints, so a leg that
visits the same corner several times pays for it once.

## Stack

TypeScript · Next.js 15 / React 19 · tRPC 11 · Prisma 6 + SQLite · Leaflet + OpenStreetMap ·
zod · Vitest · npm workspaces
