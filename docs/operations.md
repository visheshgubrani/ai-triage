# Operations

> Running ai-triage: what it logs, what it measures, what to alert on, and what to do when something goes wrong. The design behind it is in [architecture.md](architecture.md) §5 (fairness, backpressure, self-healing, timeouts). Every setting is in [configuration.md](configuration.md).

## Health checks

| Endpoint | Process | Answers 200 when |
|---|---|---|
| `GET /health` (also `/api/health`) | api | the database answers. Body: `status`, `db`, `time`, `version`. Use it for liveness |
| `GET /api/ready` | api | the database answers, no migration is pending, and the storage bucket exists. Use it for readiness |
| `GET :9100/health` | worker | its heartbeat loop ran in the last minute (a wedged event loop, or a database it can't reach, turns it 503) |
| `GET :9100/ready` | worker | the database answers |

The worker's port is `WORKER_HTTP_PORT` (default 9100). Keep it inside the private network, like `/api/metrics`. The compose files use these for their healthchecks.

Every worker also upserts a row in `worker_heartbeats` every 15 seconds. When none is newer than 2 minutes, the web shows everyone "No worker is running", `pnpm preflight` warns, and Settings → System health shows 0 workers. This is the usual cause of "I uploaded a document and nothing happens".

## Logs

The api and worker write one JSON object per line to stdout (errors to stderr). On a terminal they write a short readable line instead. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`) filters.

```json
{"time":"2026-11-04T10:12:03.418Z","level":"info","service":"worker","msg":"model call","trace":"6f3c…","provider":"anthropic","model":"claude-opus-5-5","stage":"extract","mode":"live","tokens":{"input":5120,"output":388,"cacheRead":4096},"costUsd":0.0181,"ms":4210,"stopReason":"end_turn"}
```

- **`trace`** is the id of the request that started the work: the api's request id (also the `X-Request-Id` response header). It goes into every job the request enqueues, and each job passes it on. So `grep <trace>` follows one document from upload or webhook through parse, classify, extract, route and delivery. Work the cron starts (Gmail sync, maintenance) is traced by the job id.
- **The api** logs one line per request: method, path without the query string, status, ms. Unexpected errors are logged with their request id, which the 500 response also carries.
- **The worker** logs:
  - **`job done` / `job failed`:** one line per job, with queue, job, tenant, document, run, ms and the error. A failed job is retried by pg-boss.
  - **`model call`:** one line per model call, with provider, model, stage, mode (`live`/`replay`), tokens, cost, latency and stop reason.
  - **`run failed`:** a run that failed for good, with its reason.
- **Never in logs:** document content, secrets, tokens, passwords. Errors from providers are logged by name and message.

## Metrics

Prometheus text format, at:
- the worker: `:9100/metrics`;
- the api: `/api/metrics`, which needs `Authorization: Bearer $METRICS_TOKEN` and answers 404 while `METRICS_TOKEN` is unset.

| Metric | Type | Labels | What it says |
|---|---|---|---|
| `triage_jobs_total` | counter | `queue`, `outcome` (`ok`/`error`) | Jobs handled. `error` means pg-boss retries the job |
| `triage_job_duration_seconds` | histogram | `queue` | Handler time per job |
| `triage_queue_jobs` | gauge | `queue`, `state` (`created`/`retry`/`active`) | What waits and runs, sampled every 15 s from pg-boss |
| `triage_queue_oldest_seconds` | gauge | `queue` | Age of the oldest waiting job: the best "are we keeping up" signal |
| `triage_llm_calls_total` | counter | `provider`, `model`, `stage`, `mode`, `outcome` (`ok`/`error`/`reused`) | Model calls; `reused` is a saved response served on retry |
| `triage_llm_call_seconds` | histogram | `provider`, `stage` | Model latency (recorded latency in replay) |
| `triage_llm_tokens_total` | counter | `model`, `kind` (`input`/`output`/`cache_read`) | Tokens |
| `triage_llm_cost_usd_total` | counter | `model`, `mode` | Spend; only `mode="live"` is money |
| `triage_provider_cooldown` | gauge | `provider`, `model` | 1 while a model cools down after a 429/529/503 |
| `triage_db_pool_connections` | gauge | `state` (`total`/`idle`/`waiting`) | The worker's app pool; `waiting` > 0 for long means `DB_POOL_MAX` is too low |
| `triage_worker_info` | gauge | `version`, `llm_mode` | One per worker |
| `triage_http_requests_total` | counter | `method`, `route`, `status` | API requests by route pattern (never ids) |
| `triage_http_request_seconds` | histogram | `route` | API latency |

Every worker samples the queue gauges, so take `max` across instances, not `sum`.

## Suggested alerts

| Alert | Condition | Means |
|---|---|---|
| Falling behind | `max(triage_queue_oldest_seconds{queue=~"doc.*"}) > 900` for 10 m | Documents wait more than 15 minutes for a stage. Add workers or concurrency, or check a cooldown |
| No worker | `absent(triage_worker_info)` or no heartbeat for 2 m | Nothing processes documents |
| Provider busy | `max(triage_provider_cooldown) == 1` for 15 m | A model keeps answering 429/529/503. Runs fail as `provider_unavailable` after about an hour |
| Jobs failing | `rate(triage_jobs_total{outcome="error"}[10m]) > 0.1` | Something retries a lot; the `job failed` log lines say what |
| Stalled work | Settings → System health shows stalled runs > 0, or `reconcile marked stalled work failed` in the logs | The reconciler found work no job would pick up. It's in Processing failed with Retry |
| Delivery failures | the Delivery failures view isn't empty | A webhook receiver refused or stayed down past 8 retries |
| Budget | System health shows the daily budget used up | Live calls stop until the next UTC day or a higher cap |

## Runbooks

### A provider outage (429, 529, 503)
1. **What happens on its own:**
   - The model cools down for every worker (`llm_provider_state`): its Retry-After, or a backoff doubling per busy answer up to 5 minutes.
   - Jobs give their slot back without calling or spending.
   - Classify and extract retry 10 times over about an hour, then fail as `provider_unavailable`.
2. **Once it recovers:** open Review → Processing failed, pick the reason `provider_unavailable`, and press **Retry all**. It retries each document like a reviewer's Retry, up to 500 at a time; press again for more.
3. **If it lasts:** switch the model in Settings → Pipeline (M11). The new config version reviews everything until it's recalibrated.

### The daily budget ran out
- Documents fail as `budget_exhausted`, and everyone sees a banner.
- An admin raises the cap in Settings → Daily LLM budget. Today's row takes the new cap at once.
- Then **Retry all** with the reason `budget_exhausted`.

### Documents seem stuck
1. Check System health: is the oldest document in progress old? Are workers running?
2. `pnpm preflight` (or `docker compose run --rm worker cli preflight`) checks the database, migrations, storage and each tenant's model config.
3. Follow one document: take its id from the URL, find a log line for it (`document` field), then grep that line's `trace`.
4. Work with no job left is failed by the reconciler within `RECONCILE_STALL_MINUTES` (default 30) and shows in Processing failed as `stalled`. Retry it.

### A mailbox stopped syncing
- **Settings → Mailboxes:** a `reauth_required` mailbox needs Reconnect (the refresh token expired or was revoked; in a Google app in Testing mode, every 7 days).
- **Over the tenant's inbound limit:** messages are deferred, never dropped, and the ledger shows them as `deferred`. They wake within the next hour.

### Restore from a backup
See [deploy.md](deploy.md#backups) (M14). Restore Postgres and the bucket from the same point in time, run `migrate`, then start the api and worker. The reconciler fails any run the restore left mid-pipeline, so it shows in Processing failed.
