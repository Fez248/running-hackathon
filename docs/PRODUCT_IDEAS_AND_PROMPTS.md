# Product ideas, feature mixes and build prompts

Everything below is grounded in what this repository already does. Read this first, because
every idea and prompt refers back to it.

## What exists today

**`apps/sidewalk` (Next.js 15 App Router, `@sidewalk/web`)** — a single map workspace
(`src/components/map-workspace.tsx`) with a Leaflet map, a canvas Fog of War overlay
(`fog-layer.tsx`), a run panel that drives GPS tracking (`hooks/use-run-tracker.ts`), ambient
voice reporting through the Web Speech API (`hooks/use-voice-reporter.ts`), a typed report
fallback, a manual report form, and coverage/stats panels.

**`libs/core`** — client-safe domain logic and Zod contracts, with no server imports:
- `obstacles.ts`: `OBSTACLE_KINDS` (`CURB | STEPS | ROADWORKS | CROSSING | NARROW_PATH |
  BLOCKED | STEEP_SLOPE | ROUGH_SURFACE`), `PASSABILITY`, `PROFILES` (`WHEELCHAIR | STROLLER |
  COURIER | DELIVERY_ROBOT`), `REPORT_SOURCES` (`MANUAL | VOICE`), `createReportSchema`,
  `voiceReportSchema`, `boundsSchema`, `voteSchema`.
- `scoring.ts`: `confidence()` (agree/disagree + GPS accuracy) and `passabilityForProfile()`
  (per-profile verdict from height/width).
- `fog.ts`: the `FOG_CELL_SIZE_DEG = 0.00025` grid, `fogCellKey()`, `DEFAULT_REVEAL_RADIUS_M = 25`.
- `geo.ts`: `distanceMeters()`, `boundsAround()`, `gridKey()` (~11 m dedupe grid), `clampBounds()`.
- `gps.ts`: the fix filter (accuracy gate, implausible-speed rejection, minimum spacing).
- `voice.ts`: `parseVoiceReport()` — transcript → kind/passability/measurements/confidence.

**`libs/api` (tRPC)** — `report` (`byBounds`, `byId`, `create`, `createFromVoice`, `createMany`,
`vote`, `resolve`), `coverage` (`byBounds`, `reveal`, `summary`), `trace` (`start`, `finish`,
`upload`, `recent`), `stats.summary`.

**`libs/db` (Prisma + SQLite/libSQL)** — `User`, `Report` (with `gridKey`, `clientReportId`
idempotency key, `agreeCount`/`disagreeCount`/`confidence`, `status`), `Vote`, `Trace`,
`CoverageCell` (`cellKey` unique, `visits`).

**`apps/bridge` + `libs/imukit` (Python)** — the floor-imperfection MVP. `bridge.ingest` reads
Sensor Logger / phyphox / generic CSV / ZIP recordings; `bridge.quality.assess` gates a capture
(≥100 Hz IMU, GPS error ≲3 m, gravity present, ≥30 s, dropout <2 %, verdict
`ok | degraded | unusable`); `bridge.pipeline.process_pass` estimates cadence and suppresses the
stride template; `bridge.detect` scores windows with a robust z and merges detections;
`bridge.scan` geo-locates them into `Finding`s (`kind` = `loose_or_broken_element` |
`compliant_or_absorbing`, `start_m`/`end_m`/`peak_m`, `score`, `confidence`, `lat`/`lon`) and
exports JSON/GeoJSON/CSV. `bridge.synth` simulates passes with ground truth and
`bridge.evaluate` scores detections against it.

**The seam that is not yet built.** `bridge/scan.py` already says its findings "drop straight
into the Sidewalk Map data model (`ROUGH_SURFACE` reports)", but nothing carries them there:
there is no ingest endpoint, no `SENSOR` report source, no scan record in the database, and no
UI for a scan. Most ideas below exploit that seam.

---

## 1. Product ideas

### 1.1 Sidewalk Passport (accessibility routing on crowd data)
Turn per-report passability into routing. `passabilityForProfile()` already decides whether a
curb or width is passable for a `WHEELCHAIR` vs a `COURIER`; a router that penalises segments by
the worst nearby report gives "the route my chair can actually do", which is the difference
between a map and a product.

### 1.2 Feet-as-a-sensor-network (bridge → map pipeline)
Ship the missing seam: a phone recording uploaded, quality-gated, scanned, and written back as
`ROUGH_SURFACE` reports with `source: 'SENSOR'` and a link to the scan that produced them. The
crowd stops typing about rough pavement and just walks over it.

### 1.3 Survey missions on the fog grid
The Fog of War is already a coverage model (`CoverageCell.cellKey`, `visits`). Adding a *target*
turns coverage into an assignment: "clear these 40 cells around the station" as a mission with
progress, expiry and a per-mission leaderboard — for city contracts, campus operators or
delivery fleets that need a survey done, not a game.

### 1.4 Municipal defect inbox
`Report` already carries `status` (`ACTIVE | RESOLVED | REJECTED`) and `resolve` is a protected
procedure. A triage view — cluster reports by `gridKey`, rank by
`confidence × profile impact × footfall`, export a work order, close the loop when a repair is
reported — is the paid side of the same data.

### 1.5 Robot/courier passability API
`DELIVERY_ROBOT` is a first-class profile. Expose the map as a read API — "is this crossing
passable for a 60 cm wheelbase right now, and how confident are you" — with confidence and
capture recency in the payload. Fleets are the customers who cannot crowdsource this themselves.

### 1.6 Ambient reporting as the input paradigm
Voice already works while moving, transcripts are stored for parser auditing, and
`parseVoiceReport` returns a parse confidence. Product ideas from that: a review queue for
low-confidence parses, per-language grammars, and an "utterance → correction" loop that improves
the parser from real audio instead of test fixtures.

### 1.7 Change detection over time
`Trace`, `CoverageCell.visits` and repeated scans of the same street make *change* observable:
new roadworks appearing, a repaired kerb, a surface degrading. `bridge.detect.track_modal_shift`
and `multi_pass_map` already do the multi-pass side of this for surfaces.

### 1.8 Evidence-grade capture for asset owners
The quality gate is the honest part of the bridge: it refuses to make claims about a bad
recording. Packaged as "capture certificates" (fs, GPS error, gravity, verdict attached to every
finding), it is what makes the output admissible in a facilities or insurance workflow.

---

## 2. Feature mixes (cohesive products)

### Mix A — "Sidewalk Passport": crowd map + profile routing + fog coverage
*Ideas 1.1 + 1.3 + 1.6.* One consumer product: pick your profile, get routes your wheels can
do, and the streets you have not surveyed stay fogged so the map tells you what it does not know.
Coverage becomes the honesty mechanism and the growth loop.

### Mix B — "Pavement Radar": bridge scans as first-class reports
*Ideas 1.2 + 1.8 + 1.7.* Upload a walk recording, see the quality verdict, get findings on the
map as `ROUGH_SURFACE` reports carrying their capture certificate, and watch a street's surface
score change across repeat passes. This is the mix that closes the app/bridge gap the repo
already documents.

### Mix C — "Street Ops": municipal defect inbox + survey missions
*Ideas 1.4 + 1.3 + 1.5.* The operator-facing product: commission a survey as missions, receive
clustered defects ranked by impact, dispatch, resolve, and let fleets query the resulting
passability API. The consumer app is the sensor; this is the invoice.

### Mix D — "Continuous Sidewalk Audit" (all three)
*Ideas 1.1 + 1.2 + 1.4 + 1.7.* Runners and couriers stream traces, phones scan surfaces, the
crowd confirms or disputes, the city fixes, and routing reflects the fix within a day. Each layer
is separately shippable, which is why the mixes above are ordered by effort.

---

## 3. Prompts for an AI coding/product model

Each prompt is self-contained and copy-pasteable. They assume this repository, and they assume
the repo rules in `AGENTS.md`: work on a feature branch, keep shared domain logic in `libs/core`
(no server imports), routers in `libs/api`, and run `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build` — plus `(cd apps/bridge && python -m ruff check . ../../libs/imukit)`
and `(cd apps/bridge && python -m pytest -q)` when Python changes.

### Prompt A — Sidewalk Passport (Mix A)

```
Build "Sidewalk Passport" in this repository: profile-aware pedestrian routing on top of the
existing crowdsourced reports and Fog of War coverage.

Constraints
- Reuse, do not fork: `passabilityForProfile()` and `confidence()` in libs/core/src/scoring.ts
  decide passability; `FOG_CELL_SIZE_DEG`/`fogCellKey()` in fog.ts define coverage; the fix
  filter in gps.ts stays the only GPS gate. New shared logic goes in libs/core and must stay
  free of server-only imports (it is bundled for the client).
- No new heavyweight dependency for routing: the graph is built from OSM-free data already in
  the database (Trace paths + CoverageCell centres). If a routing library is unavoidable,
  justify it and keep it server-side in libs/api.
- SQLite/libSQL: no spatial types. Keep queries as indexed lat/lng range scans like
  report.byBounds does, and keep the 500/8000-row limits in the same spirit.
- Do not change existing tRPC procedure shapes; add new ones.

Data / contracts
- libs/core: `routeRequestSchema = { from: coordinateSchema, to: coordinateSchema, profile:
  profileSchema, avoid?: obstacleKindSchema[] }` and a `RouteLeg` type carrying
  `{ from, to, distanceM, worstPassability, blockingReportIds: string[], coverageRatio }`.
- libs/core: `segmentPenalty(leg, profile, reports)` — pure, unit-testable, returns a finite
  penalty; IMPASSABLE for the profile must make a leg unusable rather than merely expensive.
- libs/api: `route.plan` (query) taking `routeRequestSchema`, returning
  `{ legs: RouteLeg[], totalDistanceM, unknownRatio, alternatives: [] }`. Reject a request whose
  endpoints are further apart than 10 km with a tRPC BAD_REQUEST.

UX
- The map draws the chosen route as a polyline, and legs whose `worstPassability` is DIFFICULT or
  IMPASSABLE in a distinct colour with a text label — never colour alone.
- A route summary card states distance, how much of the route crosses fogged (unsurveyed) cells,
  and the reports that forced a detour, each focusable and linked to its marker.
- "From here" uses the run tracker's current fix when a run is active, otherwise geolocation with
  an explicit error path (permission denied, no API, timeout).
- Loading, empty ("no route your profile can take"), and error states are all rendered; no
  component returns null while data is pending.
- Every control is keyboard reachable, errors use role="alert", live counters use aria-live.

Validation
- Zod-validate every input at the router boundary; never trust client-computed penalties.
- Vitest unit tests in libs/core for `segmentPenalty` and the route assembler: a wheelchair route
  must refuse a leg with an 8 cm curb (see the existing passabilityForProfile tests), a courier
  route must accept it, and an all-fogged route must report unknownRatio 1.
- Run typecheck, lint, test and build; add tests with each fix.

Acceptance criteria
1. `route.plan` returns a route for the seeded Berlin Mitte data for all four profiles, and the
   wheelchair route differs from the courier route on at least one leg.
2. Requesting a route through a reported IMPASSABLE-for-profile feature never returns that leg.
3. The UI shows the route, the detour reasons, and the unsurveyed share, and is operable with the
   keyboard alone.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass; new logic has tests.
```

### Prompt B — Pavement Radar (Mix B)

```
Connect apps/bridge to apps/sidewalk: a recorded walk becomes ROUGH_SURFACE reports on the map,
carrying the capture-quality evidence that produced them.

Constraints
- bridge.scan.scan_recording is the detector of record. Do not re-implement detection in
  TypeScript and do not weaken bridge.quality: a recording whose verdict is "unusable" must
  never produce map reports.
- The Python side stays a CLI/library (no new web server). The seam is a file or stdin payload:
  `python -m bridge.cli scan <recording> --format json` output is the contract.
- Existing report semantics are preserved: reports are still deduped by `clientReportId` and
  clustered by `gridKey`, and `confidence()` remains the only confidence function on the TS side.

Data / contracts
- libs/core: extend `REPORT_SOURCES` with 'SENSOR' and add
  `sensorFindingSchema = { index, kind: 'loose_or_broken_element' | 'compliant_or_absorbing',
  startM, endM, peakM, score, confidence: z.number().min(0).max(1), lat: latitudeSchema,
  lng: longitudeSchema }`
  and `scanIngestSchema = { source, format, quality: { fsHz, jitterMs, dropoutFrac, durationS,
  gravityPresent, clippingFrac, gpsPresent, gpsAccuracyM, routeLengthM, verdict:
  'ok' | 'degraded' | 'unusable', problems: string[] }, cadenceSpm, findings:
  sensorFindingSchema.array().max(500), clientScanId: z.string().min(1) }`.
  Mirror the field names emitted by ScanResult.as_dict()/Finding so the mapping is mechanical,
  and document the camelCase conversion in one place.
- libs/db: a `SurfaceScan` model (`clientScanId` unique for idempotency, verdict, fsHz,
  gpsAccuracyM, cadenceSpm, routeLengthM, createdAt) with `Report.surfaceScanId` optional
  relation. Migrate with the repo's prisma scripts; never hand-edit generated client output.
- libs/api: `scan.ingest` mutation taking `scanIngestSchema`. Rules: verdict 'unusable' stores
  the scan and returns `{ scanId, createdReportIds: [], skipped: 'unusable_capture' }`; otherwise
  each finding becomes a ROUGH_SURFACE report with `source: 'SENSOR'`, `passability: 'DIFFICULT'`
  for loose_or_broken_element and 'UNKNOWN' for compliant_or_absorbing, note = the finding
  description plus its extent in metres, and stored confidence = `confidence({agreeCount: 0,
  disagreeCount: 0, accuracyM: gpsAccuracyM}) * finding.confidence`. Use upsert on
  `clientReportId = ${clientScanId}:${finding.index}` so a re-upload is idempotent.
- Python: add `bridge.cli scan --emit-map-payload` (or an `--format map` variant) that writes
  exactly `scanIngestSchema`-shaped JSON, and unit-test the shape against a fixture.

UX
- A "Surface scan" panel: drop or pick a scan JSON, then show the quality verdict *before* the
  findings, with the failing checks listed verbatim from `problems`.
- Reports created from a scan render with a distinct marker style AND a "sensor" text badge, and
  their popup shows fs, GPS accuracy and verdict — the capture certificate.
- Degraded captures are accepted but labelled, everywhere the reports appear.
- Errors use role="alert"; upload progress and result counts are announced via aria-live.

Validation
- pytest: a synthesised pass (bridge.synth) with known anomalies produces findings whose
  map payload validates against a JSON-schema copy of scanIngestSchema; an unusable capture
  (e.g. 50 Hz) produces a payload with verdict 'unusable' and no findings claimed as trustworthy.
- Vitest: the finding→report mapping (kind, passability, confidence product, clientReportId) and
  idempotency of a repeated ingest.
- Run ruff, pytest, typecheck, lint, test, build.

Acceptance criteria
1. `python -m bridge.cli scan --demo --format map --out /tmp/scan.json` then uploading that file
   in the UI creates ROUGH_SURFACE reports at the demo route's anomaly positions.
2. Re-uploading the same file creates zero additional reports.
3. A 50 Hz recording is rejected with the reason shown to the user and no reports created.
4. All six checks (ruff, pytest, typecheck, lint, test, build) pass.
```

### Prompt C — Street Ops (Mix C)

```
Build the operator side: survey missions over the fog grid, a clustered defect inbox, and a
read-only passability API for fleets.

Constraints
- Missions are defined in fog-cell space: reuse `fogCellKey()`/`FOG_CELL_SIZE_DEG` and
  CoverageCell; do not invent a second grid. Clustering reuses `gridKey()`.
- `report.vote` and `report.resolve` are already protected procedures — keep authorisation there,
  do not move authorisation into the client.
- The fleet API is read-only and must not expose transcripts, author identities or raw traces.

Data / contracts
- libs/core: `missionSchema = { name: z.string().min(3).max(80), cellKeys:
  z.array(z.string()).min(1).max(5000), profile: profileSchema.optional(), expiresAt:
  z.coerce.date() }`, plus `missionProgress(cellKeys, revealedCellKeys)` returning
  `{ total, revealed, ratio }` as pure core logic.
- libs/core: `defectCluster(reports)` → `{ gridKey, lat, lng, kinds, worstPassability,
  reportCount, impactScore }` where impactScore is documented and monotonic in confidence,
  report count and profile severity.
- libs/db: `Mission` (name, profile, expiresAt, createdAt, status) and `MissionCell`
  (missionId + cellKey unique together).
- libs/api: `mission.create` (protected), `mission.list`, `mission.progress`;
  `defect.inbox` (query: bounds + minImpact, returns clusters ordered by impactScore);
  `defect.workOrder` (protected, returns a CSV/GeoJSON export of selected clusters);
  `public.passability` (query: `{ lat, lng, radiusM: z.number().max(200), profile }` returning
  `{ verdict, confidence, lastCapturedAt, sampleSize }` and nothing else).

UX
- An operator view separate from the runner view (a route, not a modal), with a mission list, a
  progress bar per mission (text percentage too, not colour alone), and the inbox as a sortable
  table with keyboard-navigable rows.
- Selecting a cluster highlights its cells on the map and lists the underlying reports with their
  confidence and capture source.
- Resolving a defect asks for a reason, shows the optimistic state, and rolls back visibly on
  error (role="alert").
- Every table has a caption, every column a header, and the empty inbox explains what to do next.

Validation
- Vitest for `missionProgress` and `defectCluster` including ties, single-report clusters and
  IMPASSABLE dominance.
- Router tests (or integration tests against the seeded database) for: mission creation rejects
  >5000 cells, `public.passability` never returns transcripts, and `defect.inbox` respects
  minImpact.
- Run typecheck, lint, test, build.

Acceptance criteria
1. A mission created over the seeded Berlin cells shows 0 % progress, and running the tracker
   through one of its cells raises progress on the next refetch.
2. `defect.inbox` returns clusters whose ordering matches `impactScore` and never mixes reports
   more than one `gridKey` apart.
3. `public.passability` responses contain only the documented fields (assert the exact key set).
4. typecheck, lint, test and build pass.
```

### Prompt D — Continuous Sidewalk Audit (Mix D)

```
Combine Prompts A, B and C into one coherent product with change detection over time. Do this as
an increment on top of them, not a rewrite.

Constraints
- Keep the four layers separable: capture (run tracker + bridge scans), consensus (votes and
  confidence), operations (missions and defect inbox), and routing. A failure in one layer must
  degrade gracefully rather than break the map.
- History is append-only: never mutate a Report to record a change; add observations and derive
  state. Existing `status` transitions stay the only lifecycle field.
- Performance: viewport queries stay indexed lat/lng range scans with explicit limits.

Data / contracts
- libs/core: `surfaceTrend(scans)` — pure, takes per-pass scores for one grid cell ordered by
  time, returns `{ direction: 'improving' | 'stable' | 'degrading', deltaPerMonth, sampleSize,
  confidence }`, with a documented minimum sample size below which it returns 'stable' with
  confidence 0.
- libs/api: `trend.byBounds` (query) returning per-`gridKey` trends, and `report.timeline`
  (query: reportId) returning the observation history (reports, votes, scans) for that cell.
- Reuse bridge multi-pass capability: `bridge.detect.multi_pass_map` / `track_modal_shift` for
  cell-level surface scores across recordings; expose them through the same scan payload rather
  than a second format.

UX
- One map with layer toggles (reports, fog, surface trend, missions) whose state is announced and
  persisted; no layer may cover the others' interactions.
- A cell detail panel with the timeline: what was observed, by which source (MANUAL/VOICE/SENSOR),
  with what confidence, and what changed.
- Routing prefers cells whose trend is stable/improving when the cost difference is marginal, and
  says so in the route summary.
- The whole flow is usable on a phone one-handed while walking: primary actions within thumb
  reach, no hover-only affordances, and every status change announced.

Validation
- Vitest: `surfaceTrend` for improving/degrading/insufficient-sample cases, and routing
  preference for stable cells only when penalties tie within a documented epsilon.
- pytest: multi-pass detection over synthesised repeat passes recovers the injected degradation.
- Run all six checks; no test is modified to make a failure pass.

Acceptance criteria
1. A cell with three worsening scans reports 'degrading' with sampleSize 3, and a single scan
   reports 'stable' with confidence 0.
2. The timeline for a seeded report lists its votes and any scan-derived reports in the same cell.
3. Layer toggles, cell details and routing all work with keyboard only and pass an axe check with
   no critical violations.
4. ruff, pytest, typecheck, lint, test and build all pass.
```

### Prompt E — Voice parser quality loop (Idea 1.6, small and shippable)

```
Improve ambient voice reporting into a measurable product feature.

Constraints
- `parseVoiceReport()` in libs/core/src/voice.ts stays the single parser, and the server keeps
  re-parsing transcripts (libs/api report.createFromVoice) so stored reports never depend on the
  client's parser version. Do not lower the parse-confidence bar to increase acceptance.

Data / contracts
- libs/core: export the parse-confidence thresholds as named constants, and add
  `voiceReviewDecisionSchema = { reportId, accept: z.boolean(), correctedKind:
  obstacleKindSchema.optional(), correctedPassability: passabilitySchema.optional() }`.
- libs/api: `report.voiceReviewQueue` (query, returns reports whose source is VOICE and
  confidence below the review threshold, newest first, limit 50) and `report.applyVoiceReview`
  (protected mutation) that records the correction as a new observation, not a silent overwrite.

UX
- A review card per queued utterance showing the transcript verbatim, the parse, and one-key
  accept/correct actions; keyboard-first, since this is a repetitive task.
- Every decision announces its result and can be undone within the session.

Validation
- Extend libs/core/src/voice.test.ts with the utterances that currently parse ambiguously
  (measurements without units, negations, multiple features in one sentence) as explicit
  expectations — including the ones that should remain unparsed.
- Run typecheck, lint, test, build.

Acceptance criteria
1. The queue only ever contains VOICE reports below the exported threshold.
2. A correction changes the effective kind/passability of the report and is attributable.
3. No existing voice test is weakened; new cases are added.
```

---

## 4. How to pick

Prompt B is the highest-value first move: it closes a gap the repository itself documents, it is
mostly contract work (a Zod schema, a router, one Prisma model, one CLI flag), and it makes the
bridge visible to a user for the first time. Prompt A is the strongest consumer story but needs a
routing graph the data only weakly supports today. Prompt C is where money is, and it is mostly
CRUD over primitives that already exist. Prompt D is the vision, and only makes sense once two of
the three others exist.
