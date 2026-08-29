# AGENTS.md

Guidance for AI agents (Devin and others) working in this repository.

## Branching and pushing policy

Every Devin session/task must use a dedicated feature branch and push every commit directly to the
GitHub remote.

Concretely:

- Create your own branch before making changes (e.g. `devin/<timestamp>-<slug>`); never commit to
  `main` and never commit to another session's branch.
- Push each commit to `origin` as soon as it is made — do not accumulate unpushed local work.
- Open a pull request against `main`; `main` is only updated through merged pull requests.

## Repository conventions

- npm workspaces monorepo: apps live in `apps/*`, shared libraries in `libs/*`.
- Stack: TypeScript, Next.js (App Router), tRPC, Prisma with SQLite.
- Shared domain logic (validation, geo, passability/confidence rules) belongs in `libs/core`, which
  must stay free of server-only imports so client bundles can use it.
- `libs/api` owns the tRPC routers; apps only mount them.
- Before pushing, run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Never commit `.env` files, the SQLite database, or build artifacts.
