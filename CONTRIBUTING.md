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

## The demo video

The README's teaser GIF, screenshots and the full demo video come from a script, so they can be remade after a UI change. It needs ffmpeg with libx264.

1. Start a fresh demo of your checkout. The recording approves an invoice and freezes a config, so it needs untouched demo data:

   ```bash
   docker build -t ai-triage:dev .
   TRIAGE_SOURCE=$PWD TRIAGE_IMAGE=ai-triage ./install.sh --version dev --demo --port 4700 --dir /tmp/triage-video
   ```

   Wait a minute for the seeded eval runs to finish (Evals shows them done).
2. Record (about 1.5 minutes), then render (about 5: frames are drawn by several browsers in parallel):

   ```bash
   WEB_URL=http://localhost:4700 CATCHER_URL=http://localhost:<catcher port it printed> pnpm demo:video
   ```

`scripts/demo/record.ts` drives the app and saves 2× frames plus a timeline of moves, clicks and camera cues; `render.ts` draws each frame through `compositor.html` (window, zoom, cursor, title and outro) and encodes it. The video lands in `test-results/demo/ai-triage-demo.mp4`; the GIF, the screenshots and `social-preview.png` in `docs/media/`. `pnpm demo:render --at=12,40` renders single frames to check a change; `--encode-only` re-encodes the last drawn frames in seconds (`--crf=N` for size, default 30 to stay under GitHub's 10 MB video limit; `--gpu` for a fast VAAPI draft on AMD or Intel). Remove the demo afterwards with `docker compose down -v` in its directory.

## Things that will bite

- **Requests are recorded.** Changing a prompt, a request builder, a model or a fixture changes the bytes sent to the model, and replay then misses. Re-recording spends money, so say so in the PR. AGENTS.md ("When you change X") says what else to update.
- **Tenant data** goes through `withTenantTx()`, and every tenant table has row-level security. `catalog.db.test.ts` checks new tables.
- **Only `packages/db` imports `drizzle-orm` or `pg`.**

## Reporting

- Bugs and ideas: GitHub issues.
- Security problems: privately, as [SECURITY.md](SECURITY.md) describes.
