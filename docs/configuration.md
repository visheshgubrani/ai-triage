# Configuration

> Generated from `packages/core/src/env.ts` by `pnpm config:docs`; edit there, not here.

Every variable the app reads. The api and worker check theirs at startup and list every problem at once. `pnpm preflight` checks a whole installation. Secrets are marked 🔒: keep them out of logs and version control.

Processes: **api**, **worker**, **web**, **cli** (migrations, seeds and the admin commands) and **compose** (only `docker compose` interpolation).

## Instance

| Variable | Read by | Default | Description |
|---|---|---|---|
| `TRIAGE_DEMO` | api, worker, cli, compose | – | Local demo / development. With NODE_ENV=production the api and worker refuse the dev defaults below unless this is set (docs/security.md, production checklist). Never set it on a real instance. |
| `NODE_ENV` | api, worker, cli, web | – | one of `development`, `production`, `test`. `production` turns on the startup safety checks. The Docker image sets it; leave it unset for development. |

## Postgres

| Variable | Read by | Default | Description |
|---|---|---|---|
| `POSTGRES_PORT` | compose | `5440` | Host port of the compose Postgres. |
| `DATABASE_OWNER_URL` 🔒 | cli | – | The owner role: migrations, seeds and the admin CLIs only. Never give it to the api, worker or web. |
| `MIGRATIONS_DIR` | cli | `packages/db/migrations (next to the source)` | Where `db:migrate` finds the SQL migrations. The Docker image sets it for its bundled CLI. |
| `DATABASE_URL` 🔒 (required: api, worker) | api, worker, cli | – | The app role, created by `pnpm db:migrate` and subject to row-level security. The worker needs a direct (non-pooled) connection: pg-boss uses LISTEN and advisory locks. |
| `DB_POOL_MAX` | api, worker | `10 (api); 4 + 2 × WORKER_LLM_CONCURRENCY + eval + mailbox concurrency (worker)` | Connections in the app's pool, per process (pg-boss keeps 10 more of its own). Raise it with the worker's concurrency; keep the total under Postgres's max_connections. |

## Storage

| Variable | Read by | Default | Description |
|---|---|---|---|
| `S3_PORT` | compose | `9020` | Host port of the compose RustFS (S3 API). |
| `S3_CONSOLE_PORT` | compose | `9021` | Host port of the RustFS console. |
| `S3_ENDPOINT` (required: api, worker) | api, worker, cli | – | S3-compatible endpoint the server uses (AWS: https://s3.<region>.amazonaws.com). |
| `S3_REGION` | api, worker, cli | `us-east-1` | Region used for request signing. |
| `S3_BUCKET` (required: api, worker) | api, worker, cli | – | Bucket for document sources. Keep it private; files are served through short-lived presigned URLs. |
| `S3_ACCESS_KEY_ID` (required: api, worker) | api, worker, cli | – | Storage access key. |
| `S3_SECRET_ACCESS_KEY` 🔒 (required: api, worker) | api, worker, cli | – | Storage secret key. Production refuses the dev default. |
| `S3_PUBLIC_ENDPOINT` | api, worker, cli, web | `S3_ENDPOINT` | Host used in presigned URLs, which the browser must reach (differs from S3_ENDPOINT inside docker). Keep it on its own origin: user files never share the app's origin. |

## Limits

| Variable | Read by | Default | Description |
|---|---|---|---|
| `MAX_FILE_MB` | api, worker, cli | `20` | Largest accepted file. Inline PDFs are base64-encoded (4/3 larger) and a request may not exceed 32 MB. |
| `MAX_PDF_PAGES` | worker | `100` | PDFs with more pages fail as too_many_pages. |

## Postmark inbound

| Variable | Read by | Default | Description |
|---|---|---|---|
| `POSTMARK_INBOUND_USER` | api | – | Basic-auth user in the Postmark inbound webhook URL (https://user:pass@host/api/webhooks/postmark). Unset with the password: the webhook is off. |
| `POSTMARK_INBOUND_PASSWORD` 🔒 | api | – | Basic-auth password for the Postmark webhook. Production needs 16 or more characters. |
| `INBOUND_DOMAIN` | api, cli | – | Domain of generated (unguessable) inbound addresses. Empty: new tenants get no address, and existing ones keep their domain. |

## API and web

| Variable | Read by | Default | Description |
|---|---|---|---|
| `API_PORT` | api, compose | `8787` | Port the api listens on. |
| `WEB_PORT` | compose | `3000` | Host port of the web app in the Docker demo. |
| `PUBLIC_URL` | api, cli | `WEB_ORIGIN, else http://localhost:3000` | The one address people use: the web app, with the API under /api on the same origin (cookies, the Origin check, invite links, OAuth redirect URIs). An origin only, no path. Must be https in production. |
| `WEB_ORIGIN` | api, cli | – | Older name for PUBLIC_URL, still honored when PUBLIC_URL is unset. |
| `API_INTERNAL_URL` | web | `http://localhost:8787` | How the web server reaches the api, without /api (in compose: http://api:8787). Server components call it directly; `pnpm dev` also proxies the browser's /api through it. |
| `NEXT_PUBLIC_API_URL` | api | – | No longer used (the browser calls /api on the same origin). The api warns when it's set. |
| `TRUSTED_PROXIES` | api | – | Proxies in front of the API (IPs or CIDRs, comma-separated): only their X-Forwarded-For is believed, for rate limits, audit and session IPs. Empty: the socket address is the client. |
| `RATE_LIMIT_SCALE` | api, worker | `1` | Multiplies every request limit (apps/api/src/rate-limit.ts), for a busy instance. |
| `REQUIRE_ADMIN_2FA` | api | `true (false with TRIAGE_DEMO=true)` | Admin-only routes need the admin's TOTP 2FA. Defaults to on, except with TRIAGE_DEMO=true. |

## Secrets

| Variable | Read by | Default | Description |
|---|---|---|---|
| `ENCRYPTION_KEY` 🔒 | api, worker, cli | – | Encrypts webhook signing secrets and mailbox tokens at rest: 32 random bytes, base64 (`openssl rand -base64 32`). Unset in development and the demo, a published dev key is used; production refuses to start without one. |
| `ENCRYPTION_KEYS` 🔒 | api, worker, cli | – | A key ring for rotation, newest first: `new:<base64>,old:<base64>`. Then run `pnpm secrets:rotate-key`. Takes precedence over ENCRYPTION_KEY. |
| `BETTER_AUTH_SECRET` 🔒 (required: api) | api | – | Signs sessions. Dev-only value here; generate a real one with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | api | – | No longer needed: auth runs at PUBLIC_URL/api/auth. A value on another origin is ignored with a warning. |

## Google

| Variable | Read by | Default | Description |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | api, worker, cli | – | One OAuth client for Sign in with Google and Gmail mailbox sync (docs/google.md). Leave it and the secret empty to hide every Google feature. Redirect URIs to register: <PUBLIC_URL>/api/auth/callback/google and <PUBLIC_URL>/api/integrations/google/callback. |
| `GOOGLE_CLIENT_SECRET` 🔒 | api, worker, cli | – | The OAuth client's secret. Set both or neither. |
| `GOOGLE_OAUTH_URL` | api, worker, cli | – | Points Google's consent screen at the local fake (`pnpm fake-google`, e.g. http://localhost:9040) for the demo and e2e. Production refuses it unless TRIAGE_DEMO=true. |
| `GOOGLE_TOKEN_URL` | api, worker, cli | `GOOGLE_OAUTH_URL` | The fake's token endpoint as the server reaches it, when that differs from the browser's address. |
| `GOOGLE_API_URL` | api, worker, cli | – | Points the Gmail API at the local fake. Production refuses it unless TRIAGE_DEMO=true. |
| `FAKE_GOOGLE_PORT` | cli | `9040` | Port of `pnpm fake-google`. |
| `FAKE_GOOGLE_MAILBOX` | cli | `ap@demo-workspace.test` | The address the fake Google's demo mailbox answers as. |

## Models

| Variable | Read by | Default | Description |
|---|---|---|---|
| `LLM_MODE` | api, worker, cli | `replay` | one of `replay`, `record`, `live`. replay (default: recorded responses, no key, no spend) \| record (live calls, saved as cassettes) \| live. |
| `ANTHROPIC_API_KEY` 🔒 | worker, cli | – | Needed only in record/live mode, and only when a config uses Claude. |
| `OPENAI_API_KEY` 🔒 | worker, cli | – | For `openai:` models. |
| `OPENAI_BASE_URL` | worker, cli | `https://api.openai.com/v1` | Overrides the OpenAI endpoint (a proxy or gateway). |
| `DEEPSEEK_API_KEY` 🔒 | worker, cli | – | For `deepseek:` models. |
| `DEEPSEEK_BASE_URL` | worker, cli | `https://api.deepseek.com` | Overrides the DeepSeek endpoint. |
| `OPENROUTER_API_KEY` 🔒 | worker, cli | – | For `openrouter:` models. |
| `OPENROUTER_BASE_URL` | worker, cli | `https://openrouter.ai/api/v1` | Overrides the OpenRouter endpoint. |
| `OPENAI_COMPAT_BASE_URL` | worker, cli | – | Any OpenAI-compatible server for `compat:` models, e.g. Ollama at http://localhost:11434/v1. |
| `OPENAI_COMPAT_API_KEY` 🔒 | worker, cli | – | Key for the compat server, if it needs one. |
| `CASSETTE_DIR` | worker, cli | `fixtures/cassettes` | Recorded responses (replay reads, record writes). Relative to the repo root. |
| `FIXTURES_DIR` | worker, cli | `fixtures` | The synthetic documents used by the seeds and the recorder. |

## Worker

| Variable | Read by | Default | Description |
|---|---|---|---|
| `WORKER_LLM_CONCURRENCY` | worker | `4` | Concurrent jobs per LLM stage queue (classify and extract each), per worker process. |
| `WORKER_EVAL_CONCURRENCY` | worker | `2` | Eval items processed at once (each makes up to two model calls), on top of the pipeline stages. |
| `WORKER_MAILBOX_CONCURRENCY` | worker | `4` | Gmail messages downloaded at once. |
| `MAILBOX_SYNC_BATCH` | worker | `200` | New messages one sync of a mailbox takes; the rest follow a minute later. |
| `WORKER_TENANT_CONCURRENCY` | worker | – | Fairness across tenants: at most this many of one tenant's jobs run at once per queue (pipeline stages, delivery, Gmail fetch), counted across every worker. Unset: no cap (one company). With several tenants, about half the cluster's slots per LLM queue (replicas × WORKER_LLM_CONCURRENCY). |
| `WORKER_TENANT_EVAL_CONCURRENCY` | worker | – | The same cap for eval items, so one tenant's eval run can't take every eval slot. |
| `WORKER_SHUTDOWN_GRACE_MS` | worker | `25000` | On SIGTERM, how long running jobs may finish before their model calls are aborted (they retry on another worker). Keep it under the container's stop grace period. |
| `RECONCILE_STALL_MINUTES` | worker | `30` | Work unchanged this long is checked against the queue: a run, delivery or eval run with no job left is marked failed (Processing failed, Delivery failures), never silently re-run. At least 15. |
| `PARSE_TIMEOUT_MS` | worker | `60000` | Files are parsed in a sandboxed thread; one that takes longer fails as parse_timeout. |
| `PARSE_MAX_MEMORY_MB` | worker | `512` | Heap limit of the parse thread. A file that needs more fails as parse_timeout. |

## Webhooks

| Variable | Read by | Default | Description |
|---|---|---|---|
| `WEBHOOK_ALLOWED_HOSTS` | api, worker | – | URLs must be public https hosts (SSRF guard). Receivers on a private network go here as hostnames or CIDRs (these may also use http). TRIAGE_DEMO adds localhost and the catcher. |
| `WEBHOOK_TIMEOUT_MS` | worker | `10000` | How long a delivery waits for the receiver. |
| `CATCHER_PORT` | compose | `9030` | Host port of the local webhook catcher (docker compose). |
| `DEMO_WEBHOOK_URL` | cli | – | The demo tenant's webhook, which the seed points at the catcher. |
| `DEMO_WEBHOOK_SECRET` 🔒 | cli | – | The demo tenant's signing secret (the catcher verifies with it). |

## CLI

| Variable | Read by | Default | Description |
|---|---|---|---|
| `TRIAGE_API_URL` | cli | `http://localhost:8787` | `pnpm ingest <file>`: where the API is (the api itself in dev, or PUBLIC_URL in Docker). |
| `TRIAGE_API_KEY` 🔒 | cli | – | `pnpm ingest <file>`: a tenant API key (create one with `pnpm api-key:create --tenant demo`). |

## End-to-end tests

| Variable | Read by | Default | Description |
|---|---|---|---|
| `WEB_URL` | cli | `http://localhost:3000` | `pnpm e2e`: the running web app. |
| `API_URL` | cli | `WEB_URL/api` | `pnpm e2e`: the API, by default WEB_URL/api. |
| `CATCHER_URL` | cli | `http://localhost:9030` | `pnpm e2e`: the webhook catcher. |
| `FAKE_GOOGLE_URL` | cli | `http://localhost:9040` | `pnpm e2e`: the fake Google (`pnpm fake-google`). |
| `WALKTHROUGH_VIDEO` | cli | – | `pnpm e2e`: record videos of the walkthroughs (the README GIFs). |
