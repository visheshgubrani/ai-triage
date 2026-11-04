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
- Bounded everything that could hang:
  - model calls (per-stage timeouts, pg-boss owning retries, aborted when the job expires);
  - dead workers (heartbeats);
  - parsing (a sandboxed thread with time and memory limits, `parse_timeout`);
  - Postgres (statement, lock and pool timeouts);
  - S3 and slow HTTP clients;
  - shutdown (the worker drains, then aborts its in-flight calls).
- Fairness across tenants: `WORKER_TENANT_CONCURRENCY` caps how many of one tenant's jobs run at once per queue, across every worker. Eval items have their own cap (`WORKER_TENANT_EVAL_CONCURRENCY`).
- Self-healing: every five minutes a reconciler finds runs, deliveries and eval runs left waiting on a job that no longer exists, and fails them visibly. Runs go to Processing failed as `stalled`, deliveries to Delivery failures. Nothing is silently re-run.
- **Retry all** on the Processing failed view (admins), optionally for one reason, such as after a provider outage.
- Observability:
  - JSON logs with a trace id that follows a document from its request through every job;
  - Prometheus metrics (worker `:9100/metrics`, api `/api/metrics` behind `METRICS_TOKEN`);
  - `/api/ready`, and the worker's `/health` and `/ready`;
  - worker heartbeats with a "No worker is running" banner, and a budget-reached banner;
  - Settings → System health;
  - `docs/operations.md` (alerts and runbooks) and `docs/troubleshooting.md`.
- **The simulator** (`pnpm llm-sim`, `sim:simulated`): schema-valid fake answers from the document text, with latency and fault injection. It works in any LLM mode, costs nothing, and its calls are stored as `simulated`.
- **A mail variety generator** of hundreds of kinds of real-world email, a parse robustness test over 500 of them, and **`pnpm load`**: a load and chaos test with invariant checks. The results are in `docs/reliability.md`.
- **Settings → Pipeline:** pick each stage's model and effort (with which ones a running worker can call), and the sender policy. Saving activates a version that reviews every category.
- **Activation:** an unfrozen version may be activated when it auto-approves nothing. Freeze turns on automation only with at least 3 calib items and one required field for the category.
- **First-run setup:** a fresh install logs a one-time link to `/setup`, which creates the first workspace and its admin's invitation (`pnpm setup-link` prints a new one).
- **A getting-started checklist** for admins, derived from the workspace's data.
- **Send test event** on the webhook settings: a signed `ping`.
- **UI polish:** error, not-found and loading pages, a datasets empty state, and list fields editable in review.
- **Intake filters:** auto-replies and bounces (and bulk mail, when turned on in Settings) end as `skipped` before any model call, with no review task. Documents → Skipped has Process anyway.
- **Documents list:** filters by status, source and category, a title search, and paging.
- Provider backpressure: a busy answer (429, 529, 503) cools that model down for every worker, honoring Retry-After. Classify and extract ride out about an hour of it before failing as `provider_unavailable`.

### Fixed

- A slow model call could outlast its job's expiry, so pg-boss retried it while the first call was still running and paid twice. Expiries now outlast the longest call.
- A Gmail message deferred by the inbound limit could lose its next job if the worker crashed at the wrong moment. Deferred messages also all woke at once, and each refused attempt counted against the limit again.
- A Postmark redelivery counted against the tenant's inbound limit.
- A Postgres restart could crash the worker: a connection that died while checked out emitted an unhandled `error` event.
- A `.env` copied from `.env.example` no longer points the Docker demo's fake Google at the real one.
- The Docker demo no longer gives the database owner URL to the api, worker and web, or any secret to web.
