# Troubleshooting

> Start with `pnpm preflight` (in Docker: `docker compose run --rm worker cli preflight`). It checks versions, the environment, Postgres, migrations, storage, workers and each tenant's model config, and prints the fix for whatever fails. The sections below are the problems people hit most, by symptom.

## Nothing happens after I upload a document

- **The banner says "No worker is running".** The api accepts documents, but only the worker processes them.
  - Locally, `pnpm dev` starts the api, worker and web together. Look for the worker's own errors in its output.
  - In Docker, run `docker compose ps worker` and `docker compose logs worker`.
- **The worker runs, but the document waits.** Open Settings → System health:
  - **Models cooling down:** the provider is answering 429/529/503, and calls resume by themselves.
  - **The oldest in progress keeps growing:** the worker can't keep up. Raise `WORKER_LLM_CONCURRENCY`, or add workers.
- **The document failed.** Open Review → Processing failed; the Error column says why. The common reasons:
  - `cassette_missing`: the config's model has no recorded responses, and replay mode never calls a model. Your own documents need `LLM_MODE=live` and the provider's key (for example `ANTHROPIC_API_KEY`) on the worker. Only the demo's fixtures replay.
  - `llm_bad_request` with "… is not set": the provider key is missing on the worker.
  - `budget_exhausted`: today's LLM budget is used up. Raise it in Settings, then press Retry all.
  - `provider_unavailable`: the provider stayed busy for about an hour. Press Retry all once it recovers.
  - `stalled`: the reconciler found the run waiting on a job that no longer exists. Press Retry.
  - `unsupported_file`, `parse_error`, `parse_timeout`: the file can't be read, or took too long to parse.

## The api or worker won't start

They list every problem at once, and each line says what to do. The usual ones:

| Message | Fix |
|---|---|
| `… is not set` | `cp .env.example .env` locally; in Docker, set it in the environment (docs/configuration.md) |
| `Postgres isn't reachable at …` | `pnpm infra:up`, or check `DATABASE_URL` |
| `Postgres refused the login …` | `pnpm db:migrate` creates the app role. Check that `DATABASE_URL`'s user and password match what you migrated with |
| `The database is N migrations behind …` | `pnpm db:migrate` (in Docker, the init or migrate service) |
| `Database role … bypasses row-level security` | `DATABASE_URL` points at the owner. Use the app role from `.env.example` |
| `Refusing to start in production with unsafe settings` | Fix each listed setting (docs/security.md, production checklist), or set `TRIAGE_DEMO=true` for a local demo |

## Sign-in or the page doesn't work

- **"Request origin not allowed":** the page's origin isn't `PUBLIC_URL`. Open the app at exactly that address, including the scheme and port.
- **You're signed out after every request, or sign-in loops:** everything must come from one origin, the web app with the API under `/api`.
  - Behind your own proxy, route `/api/*` to the api and the rest to web (deploy/Caddyfile does this).
  - Don't serve the API from another host.
- **Google sign-in or mailbox connect fails with `redirect_uri_mismatch`:** register `<PUBLIC_URL>/api/auth/callback/google` and `<PUBLIC_URL>/api/integrations/google/callback` exactly (docs/google.md).

## Uploads fail, or PDFs don't show

The browser uploads to, and reads from, storage directly at `S3_PUBLIC_ENDPOINT`. So it must be reachable from the browser, and the bucket's CORS must allow `PUBLIC_URL` (the api sets that at startup; preflight checks it).

## The demo in Docker

- **A port is already in use:** `install.sh --demo` picks free ports by itself (and `--port` moves the app). From a clone, set `WEB_PORT`, `POSTGRES_PORT`, `S3_PORT`, `S3_CONSOLE_PORT`, `CATCHER_PORT`, `FAKE_GOOGLE_PORT` or `SIM_PORT` in the environment or `.env`.
- **`docker compose up` builds instead of pulling:** there's no published image for `TRIAGE_VERSION` yet, so it builds from your checkout. That's expected before the first release.
- **Start over:** `docker compose down -v` deletes the demo's data; then run `docker compose up` again.
