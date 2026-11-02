# ai-triage

An open-source AI triage inbox. Emails and documents come in, Claude classifies them and extracts structured, schema-validated fields, and anything uncertain goes to a human approval queue instead of being acted on. An evals page measures accuracy per category plus cost and latency per request.

> **Status: early scaffold.** The monorepo, infra and health checks are in place. The pipeline, review queue and evals are being built. See [docs/architecture.md](docs/architecture.md) for the design.

## Stack

TypeScript · Hono (API) · Next.js (UI) · Postgres + Drizzle + pg-boss · S3-compatible storage (RustFS locally) · Claude API · pnpm + Turborepo · Biome · Vitest

## Getting started

Requires Node ≥ 24, pnpm 12 and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres on :5440, RustFS on :9020
pnpm db:migrate
pnpm dev           # web http://localhost:3000 · api http://localhost:8787
```

LLM calls default to **replay mode** (recorded responses, no API key, no spend). Set `LLM_MODE=live` and `ANTHROPIC_API_KEY` to call Claude for real.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## License

MIT
