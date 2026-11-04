# Changelog

All notable changes to ai-triage. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may break things, and says how below). Each release publishes `ghcr.io/visheshgubrani/ai-triage:<version>`.

## [0.7.0] - Unreleased

Phase 7: production-ready (docs/architecture.md §9).

### Breaking

- **The API moved under `/api`, on the web app's origin.** Set `PUBLIC_URL` to the address people use (`WEB_ORIGIN` still works). `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` are ignored, with a warning.
  - Google redirect URIs change to `<PUBLIC_URL>/api/auth/callback/google` and `<PUBLIC_URL>/api/integrations/google/callback`: register them before upgrading (docs/google.md).
  - The Postmark webhook is now `https://user:pass@<host>/api/webhooks/postmark` and the REST API `/api/v1/...`. The old root paths still answer, with a `Deprecation` header.
  - Sessions issued on the old API host don't carry over: everyone signs in again once.
- **The image's commands changed.** It has one entrypoint: `api`, `worker`, `web`, `migrate`, `seed-demo` or `cli <command>` (it no longer contains pnpm or the workspace).

### Added

- `pnpm dev:setup` and `pnpm dev:reset`: from a fresh clone to `pnpm dev` in one command.
- `pnpm preflight`: checks versions, the environment, Postgres, migrations, storage, and whether each tenant's model config can run, with the fix for each problem.
- `docs/configuration.md`, generated with `.env.example` from one registry of every environment variable (`packages/core/src/env.ts`).
- The api and worker list every environment problem at once, explain an unreachable database or a missing app role, and refuse to start while migrations are pending.
- A prebuilt, multi-arch image on GHCR (amd64 and arm64, with SBOM and provenance). It's 316 MB, down from 1.86 GB. `docker compose up` pulls it, and builds locally when there's no published image.
- The version is shown in `/api/health` and the web footer.

### Fixed

- A `.env` copied from `.env.example` no longer points the Docker demo's fake Google at the real one.
- The Docker demo no longer gives the database owner URL to the api, worker and web, or any secret to web.
