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

## Stack

TypeScript · Next.js 15 / React 19 · tRPC 11 · Prisma 6 + SQLite · Leaflet + OpenStreetMap ·
zod · Vitest · npm workspaces
