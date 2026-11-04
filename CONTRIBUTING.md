# Contributing

Thanks for helping. This page is the short version; [AGENTS.md](AGENTS.md) holds the conventions (for people and coding agents alike), and [docs/architecture.md](docs/architecture.md) the design they come from.

## Set up

Requires Node ≥ 24, pnpm 12 and Docker.

```bash
pnpm install
pnpm dev:setup     # .env, Postgres :5440, storage :9020, webhook catcher :9030, migrations, demo data
pnpm dev           # web and API at http://localhost:3000, plus the worker
```

`pnpm preflight` explains anything that isn't ready. The demo signs in as `admin@demo.test` / `demo-password`. Model calls replay recorded answers by default, so you need no API key and spend nothing.

## Before you open a pull request

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

- **Tests:**
  - `pnpm test` needs the local infrastructure (`pnpm infra:up`); `pnpm test:unit` doesn't.
  - Tests sit next to the code as `*.test.ts`, and `*.db.test.ts` for ones that need Postgres.
  - `pnpm e2e` runs the Playwright walkthroughs against a running `pnpm dev`.
- **Formatting:** `pnpm format` (Biome: 2 spaces, double quotes, 120 columns).
- **Schema changes:** edit `packages/db/src/schema`, then `pnpm db:generate`. Never edit a migration that has been applied.
- **Environment variables:** declare each in `packages/core/src/env.ts`, then `pnpm config:docs`.
- **Installer changes** (`install.sh`, `deploy/`): build the image (`docker build -t ai-triage:dev .`) and install from your checkout:

  ```bash
  TRIAGE_SOURCE=$PWD TRIAGE_IMAGE=ai-triage ./install.sh --version dev --port 4200 --dir /tmp/triage-test
  ```

  CI runs `scripts/install-smoke.sh` on every push.

## Things that will bite

- **Requests are recorded.** Changing a prompt, a request builder, a model or a fixture changes the bytes sent to the model, and replay then misses. Re-recording spends money, so say so in the PR. AGENTS.md ("When you change X") says what else to update.
- **Tenant data** goes through `withTenantTx()`, and every tenant table has row-level security. `catalog.db.test.ts` checks new tables.
- **Only `packages/db` imports `drizzle-orm` or `pg`.**

## Reporting

- Bugs and ideas: GitHub issues.
- Security problems: privately, as [SECURITY.md](SECURITY.md) describes.
