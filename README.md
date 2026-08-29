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
(force-reset the schema, then seed) to get back to the 8-report fixture.

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

## Stack

TypeScript · Next.js 15 / React 19 · tRPC 11 · Prisma 6 + SQLite · Leaflet + OpenStreetMap ·
zod · Vitest · npm workspaces
