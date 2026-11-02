# ai-triage

An open-source AI triage inbox. Emails and documents come in, Claude classifies them and extracts structured, schema-validated fields, and anything uncertain goes to a human approval queue instead of being acted on. An evals page measures accuracy per category plus cost and latency per request.

> **Status: foundation in place.** These parts work: the multi-tenant data model with row-level security, sign-in with tenants and roles, and the job queue. The pipeline, review queue and evals are being built. See [docs/architecture.md](docs/architecture.md) for the design.

## Stack

TypeScript · Hono (API) · Next.js (UI) · Postgres + Drizzle + pg-boss · S3-compatible storage (RustFS locally) · Claude API · pnpm + Turborepo · Biome · Vitest

## Getting started

Requires Node ≥ 24, pnpm 12 and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres on :5440, RustFS on :9020
pnpm db:migrate    # creates the app's database role, applies migrations, installs the job queue
pnpm db:seed       # model prices, a demo tenant and 60 synthetic documents
pnpm dev           # web http://localhost:3000 · api http://localhost:8787
```

Sign in at http://localhost:3000/sign-in as `admin@demo.test` or `reviewer@demo.test`, with the password `demo-password`. These are **dev-only** demo credentials created by the seed.

The app connects to Postgres as a restricted role (`DATABASE_URL`), so row-level security always applies. Only migrations and seeds use the owner (`DATABASE_OWNER_URL`).

LLM calls default to **replay mode** (recorded responses, no API key, no spend). Set `LLM_MODE=live` and `ANTHROPIC_API_KEY` to call Claude for real.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm test` includes database tests (tenant isolation, constraints, queue atomicity, auth), which run against a scratch `triage_test` database and need `pnpm infra:up`. `pnpm test:unit` runs without Postgres. CI runs everything on every push.

## License

MIT

## Known limits

- **Repeated model calls are possible.** Each response is saved as soon as it arrives and reused on retry, but a worker that crashes between Claude answering and that save pays for the call again on retry. Every attempt is kept for cost accounting, and only one is canonical.
- **Evidence matching proves a quote exists, not that it supports the value.** A verbatim quote must appear in the source (or on the cited PDF page); scans and images can't be checked, so they always go to review.
- **The prompt-injection fixtures are regression tests, not proof of resistance.** Triage calls have no tools, the only action is a webhook to a tenant-configured target, and automation is opt-in per category, which keeps the damage of a confidently wrong answer small.
- **Replay figures are recorded figures.** In replay mode, tokens, cost and latency come from the cassette, and are labeled as such (`llm_calls.mode = 'replay'`).
