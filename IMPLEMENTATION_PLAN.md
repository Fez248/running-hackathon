# Sidewalk Map — Implementation Plan

## 1. Vision

Sidewalk Map is a crowdsourced accessibility map of the *pedestrian* layer of a city: curbs,
steps, roadworks, blocked pavements and passable crossings. Wheelchair users, stroller users,
couriers and delivery robots need to know whether a route is actually rollable — data that
street-level map providers largely do not have.

The data is collected by people who are already moving: runners and riders capture a feature in
one or two taps as they pass it, and other contributors confirm or dispute it later. The same
observation is then re-interpreted per travel profile: a 6 cm curb is a non-event for a courier
on a bike, a nuisance for a stroller and a wall for a wheelchair.

## 2. Repository layout

```
running-hackathon/
├── apps/
│   └── sidewalk/            # @sidewalk/web — Next.js 15 App Router UI + tRPC HTTP handler
│       └── src/
│           ├── app/         # layout, page, api/trpc/[trpc]/route.ts
│           ├── components/  # map workspace, leaflet map, capture form, stats
│           └── trpc/        # react-query + tRPC client provider
├── libs/
│   ├── core/                # @sidewalk/core — domain enums, zod schemas, geo + scoring (framework-free)
│   ├── db/                  # @sidewalk/db — Prisma schema (SQLite), client singleton, seed
│   └── api/                 # @sidewalk/api — tRPC context, routers, shared transformer
├── tsconfig.base.json       # shared compiler options + @sidewalk/* path aliases
└── package.json             # npm workspaces: apps/*, libs/*
```

Design decisions:

- **npm workspaces**, no build step for libraries. `libs/*` publish TypeScript source
  (`main: src/index.ts`) and are compiled by the consuming app through
  `transpilePackages` + `experimental.externalDir`. Zero-config for a hackathon, and a second app
  (`apps/<name>`, e.g. an operator/city dashboard or a robot-routing service) reuses the libs by
  adding the workspace dependency only.
- **Domain logic lives in `libs/core`**, not in the app or the routers, so the second app and any
  future background jobs share passability rules, confidence scoring and geo helpers.
- **`libs/api` owns the whole tRPC surface**; the app only mounts it at `/api/trpc`. A second app
  can mount the same router or call it as a typed client.

## 3. Tech stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript 5.6, strict, `noUncheckedIndexedAccess` |
| App framework | Next.js 15 (App Router, React 19) |
| API | tRPC 11 (fetch adapter) + superjson transformer |
| Data fetching | @tanstack/react-query 5 via `@trpc/react-query` |
| Database | Prisma 6 + SQLite (`libs/db/prisma/dev.db`) |
| Map | Leaflet + react-leaflet, OpenStreetMap raster tiles (no API key) |
| Validation | zod schemas shared by client, router and seed |
| Tests | Vitest (domain logic in `libs/core`) |

SQLite is deliberate for the hackathon: file-based, zero setup, `db push` in seconds. Because
SQLite has no spatial index, viewport queries are indexed lat/lng range scans (`@@index([lat, lng])`),
which is fine to city scale. Postgres + PostGIS is the documented upgrade path (see §9).

## 4. Data model (`libs/db/prisma/schema.prisma`)

- **User** — `handle`, optional `profile`, `points` (gamification for contributors).
- **Report** — one crowdsourced observation: `lat`/`lng`, `gridKey` (coordinate snapped to ~11 m so
  duplicate sightings of the same curb cluster), `kind`, `passability`, optional `heightCm`,
  `widthCm`, `note`, `photoUrl`, `accuracyM` (GPS quality), `capturedByProfile`,
  `clientReportId` (unique → idempotent offline replay), `agreeCount`/`disagreeCount`/`confidence`,
  `status` (`ACTIVE` | `RESOLVED` | `REJECTED`).
- **Vote** — confirm/dispute, unique per `(reportId, userId)`.
- **Trace** — a run/ride: JSON path, `distanceM`, timestamps; reports captured during it link back
  to it, which gives "surveyed coverage" separately from "reports found". Opened when a run starts
  (empty path) and closed with the path on stop, so mid-run coverage can be attributed to it.
- **CoverageCell** — one revealed Fog of War cell: `cellKey` (unique `${y}_${x}` grid index at
  `FOG_CELL_SIZE_DEG = 0.00025`, ~28 m), denormalised centre `lat`/`lng` for indexed viewport scans,
  `visits`, `bestAccuracyM`, optional `traceId`/`userId`. Keying by cell makes reveal idempotent:
  running the same street twice cannot double-clear or duplicate rows.
- **Report** additionally carries `source` (`MANUAL` | `VOICE`) and `transcript`, so a dictated
  report keeps the raw utterance the parser was fed.

Enums are stored as strings because SQLite lacks native enums; the single source of truth is
`libs/core/src/obstacles.ts` (`OBSTACLE_KINDS`, `PASSABILITY`, `PROFILES`) with matching zod enums.

**Derived values.** `confidence()` is a Wilson-style ratio damped by poor GPS accuracy;
`passabilityForProfile()` turns a raw measurement into a per-profile verdict using max curb height
and minimum width thresholds per profile. Both are pure functions in `libs/core`, unit tested.

## 5. API surface (`libs/api/src/routers`)

| Procedure | Type | Purpose |
| --- | --- | --- |
| `report.byBounds` | query | Viewport fetch, optional `kinds` filter, returns `effectivePassability` for the selected profile |
| `report.byId` | query | Detail view with author and votes |
| `report.create` | mutation | One-tap capture; idempotent on `clientReportId` |
| `report.createMany` | mutation | Offline queue flush (≤200 reports, upsert by `clientReportId`) |
| `report.vote` | mutation | Confirm/dispute; recomputes counts, confidence and auto-rejects heavily disputed reports |
| `report.resolve` | mutation | Mark a feature fixed (roadworks removed, ramp built) |
| `trace.upload` | mutation | Store a run/ride path in one call, server-computes distance |
| `trace.start` / `trace.finish` | mutation | Open a trace at run start, close it with the path on stop |
| `coverage.byBounds` | query | Revealed fog cells in the viewport, with their bounds |
| `coverage.reveal` | mutation | Reveal fog along a batch of accepted GPS fixes (batched create/update, idempotent per cell) |
| `coverage.summary` | query | Cell count and explored area for the "explored" readout |
| `report.createFromVoice` | mutation | Dictated utterance geocoded to the live fix; re-parsed server-side, ignored when it names no feature |
| `trace.recent` | query | Recent traces for coverage display |
| `stats.summary` | query | Report counts by kind, surveyed km, contributor leaderboard |

Context (`createTRPCContext`) resolves an optional contributor from an `x-sidewalk-user` header —
a hackathon stand-in that keeps every procedure auth-shaped without blocking on real login.

Routes: `/` (map workspace), `/api/trpc/[trpc]` (all data access).

## 6. Map & crowdsourcing UX

Implemented in this scaffold:

- Full-height Leaflet map with OSM tiles; reports rendered as colour-coded circles
  (green passable / amber difficult / red impassable / grey unknown) with popups.
- Viewport-driven loading: `moveend` refetches `report.byBounds`, so the map scales to a city.
- **Profile switch** ("I travel as": wheelchair / stroller / courier / delivery robot) recolours the
  map by re-deriving passability per profile — the core insight of the product.
- Feature-kind filter chips.
- Capture form: tap the map (or "Use my location") → kind, passability, optional curb height, note →
  send. Sends a `clientReportId` so retries never duplicate.
- Coverage/leaderboard panel from `stats.summary`.

Planned for the demo build-out (in priority order):

1. **Capture-while-moving mode** — a large 4-button pad (curb / steps / blocked / crossing ok) bound
   to the live GPS position, so a report needs one tap and no typing.
2. **Offline queue** — service worker + IndexedDB buffer flushed through `report.createMany`.
3. **Confirm flow** — when a user is within ~15 m of an existing report, surface "still there?" with
   yes/no, feeding `report.vote`.
4. **Route sanity check** — pick A→B, colour the straight-line corridor by worst blocker for the
   active profile (a routing-graph-free approximation good enough to demo the value).
5. **Trace recording** — start/stop a run, upload the path, show surveyed streets as a heat overlay
   and award points for new coverage.

Added on top of the scaffold (Fog of War):

- Canvas fog overlay in Leaflet's `overlayPane` — a single canvas with `destination-out` holes for
  revealed cells, pending local cells and a live radial hole, instead of thousands of rectangles.
- Run controls: high-accuracy `watchPosition` filtered by `libs/core/src/gps.ts`, optimistic local
  fog clearing, batched `coverage.reveal`, follow-the-runner panning, live path polyline.
- Ambient voice reporting: Web Speech API dictation parsed by `libs/core/src/voice.ts`, geocoded to
  the latest accepted fix, with a typed fallback where the API is unavailable.

## 7. MVP scope (hackathon cut)

**In scope (done ✅ / next ▶):**

- ✅ Monorepo, TypeScript, Prisma+SQLite, tRPC wired end-to-end with seed data.
- ✅ Map with viewport loading, profile-aware passability, filters, report capture, stats.
- ▶ One-tap capture pad + GPS follow mode.
- ▶ Confirm/dispute from the map.
- ▶ Offline queue.
- ▶ Route sanity check for the pitch.
- ✅ Fog of War coverage, high-accuracy run tracking and ambient voice reporting.

**Out of scope:** real auth/SSO, photo upload storage, moderation console, OSM write-back,
true routing engine, native app, multi-city tiling infrastructure.

## 8. Validation & testing

- `npm run typecheck` — strict `tsc` across all four workspaces.
- `npm test` — Vitest unit tests for geo (`distanceMeters`, `boundsAround`, `gridKey`) and scoring
  (`confidence`, `passabilityForProfile`), i.e. the rules a demo can get wrong silently.
- `npm run lint` — `eslint-config-next` on the app.
- `npm run build` — production Next build (also type-checks the app routes).
- `npm run db:push && npm run db:seed` — reproducible Berlin Mitte fixture.
- Fog/GPS/voice rules are unit tested in `libs/core` (grid key stability, accuracy/jump/jitter
  rejection, smoothing weights, parser precision incl. ambient chatter that must be ignored).
- Not covered yet: a browser run cannot be exercised on a desktop without synthetic fixes, so fog
  clearing along a real path is unverified by automated tests.
- Next testing steps: router integration tests against a temporary SQLite file
  (`appRouter.createCaller`), a zod round-trip test per procedure input, and one Playwright smoke
  test (load map → capture report → marker appears).

## 9. Next steps beyond the hackathon

1. Swap SQLite for Postgres + PostGIS; replace bbox scans with `ST_DWithin`, add clustering/tiles
   (`/api/tiles/{z}/{x}/{y}`) for city-scale rendering.
2. Real accounts and anti-abuse: rate limits per device, reputation weighting in `confidence`,
   moderation queue for `REJECTED` reports.
3. Aggregate reports into *features* (dedupe by `gridKey` + kind) so the map shows one truth per
   curb rather than N sightings.
4. Real routing: build a pedestrian graph from OSM, penalise edges by profile passability, expose
   `route.plan` in `libs/api`.
5. Second app in `apps/` (e.g. `apps/ops` city dashboard or `apps/robot` routing service for
   delivery-robot fleets) consuming `libs/core` + `libs/api` unchanged.
6. OSM write-back for confirmed, high-confidence features; import existing `kerb`/`crossing` tags.

## 10. Local setup

```bash
npm install
cp .env.example .env            # DATABASE_URL, resolved relative to the Prisma schema
npm run db:generate
npm run db:push
npm run db:seed
npm run dev                     # http://localhost:3000
```

`npm run setup` chains install → generate → push → seed.
