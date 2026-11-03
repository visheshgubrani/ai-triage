# AGENTS.md

Context for coding agents (and humans) working in this repo. Read this first, then `docs/architecture.md` for the full design.

## What this is

**ai-triage** is an open-source, multi-tenant AI triage inbox:

1. Emails (Postmark inbound forwarding) and documents (uploads, REST API) come in.
2. An LLM (Claude) **classifies** each one and **extracts structured fields** against a versioned JSON Schema, which is validated with Ajv.
3. Deterministic **gates** plus a confidence **threshold** decide the route: auto-approve (only for categories where the tenant opted in) or a **human approval queue**.
4. Approved items produce a frozen action (a signed webhook) through a transactional outbox.
5. An **evals page** runs the same pipeline over a labeled dataset (dev/calib/test splits) and reports per-category accuracy, auto-approve precision (with n and a Wilson lower bound), and cost and latency per request.

It's an MVP and a portfolio project. Be correct where correctness is cheap, keep it runnable by a stranger with no API key, and keep it readable. Enterprise hardening goes under "Later" in the architecture doc.

## Current status

**Phase 1 (foundation) is done.** Here is what exists and works:
- pnpm + Turborepo monorepo, TypeScript, Biome, Vitest (`unit` and `db` projects), GitHub Actions CI with a Postgres service.
- `packages/db`:
  - The full data model (§4) in `src/schema/`, migration `0001_schema` (generated) and `0002_rls` (hand-written: grants, RLS on every tenant table, immutability triggers).
  - `withTenantTx()` with a pg-boss `queueDb` adapter, plus `enqueue()`, `createBoss()`, and the pg-boss install in `runMigrations()`.
  - Better Auth (`createAuth()`), with organizations as tenants and the roles admin, reviewer and viewer.
  - `createTenant()`, `getMembership()`, `ensurePasswordUser()`.
  - The immutable config repo (`createConfigVersion`, `freezeConfig`, `setActiveConfig`, `getActiveConfig`).
  - Seeds: `model_prices` and the demo tenant and users.
- `apps/api`: `createApp({ db, auth, webOrigin })` with `/api/auth/*`, `GET /health` and `GET /me` (`requireTenant()` / `requireRole()` middleware). It exports a typed RPC client (`@ai-triage/api/client`).
- `apps/worker`: pg-boss as the app role (never migrates), plus the `system.ping` smoke-test queue.
- `apps/web`: Next.js 16 App Router with Tailwind 4. A `/sign-in` page (Better Auth client); the home page shows the session's tenant and role, and API health.
- `packages/core`: every closed set as an `as const` array (statuses, task kinds, roles, `MODEL_IDS`, `EFFORTS`, `QUEUES`, …) plus `ACTIONS_BY_TASK_KIND`.
- `packages/llm`: `getLlmMode()` (replay by default).
- `packages/schemas`: an Ajv 2020 factory.
- `packages/evals`: `wilsonLowerBound()` with tests.
- `packages/contracts`: `HealthResponse`, `MeResponse`, `ErrorResponse`.
- Docker: Postgres 17 and RustFS (S3-compatible), with a bucket created by a one-shot container.

**Phase 2 (pipeline) is done**, except recording the cassettes (see below):
- Ingestion (`packages/ingest`): two-step upload (`POST /uploads`, `POST /uploads/:id/complete`), the Postmark webhook (`POST /webhooks/postmark`, basic auth), the REST API (`POST /v1/documents`, tenant API key) and `pnpm ingest <file>`. Emails are normalized to `email.json` with attachments as separate objects (`packages/storage`, server-issued keys).
- Tenant lookups before a tenant context (inbound address, API key) go through `SECURITY DEFINER` functions owned by `app_resolver` (migration `0003_resolvers`).
- The pure pipeline in `@ai-triage/core/pipeline`: parsers (email, DOCX, PDF text detection, images), request builders, output parsing, evidence check, gates, `route()` and `evaluateExtraction()` (the single entry point the phase 4 eval runner reuses).
- `packages/llm`: the gateway (attempt reuse, budget reservation, cost, fallback detection) and live / record / replay transports with cassettes in `fixtures/cassettes`.
- `apps/worker`: parse → classify → extract → route handlers, the `doc.failed` dead-letter handler, and `drainTenantJobs()` for tests and the recorder.
- Built-in categories (`invoice`, `support_request`, `contract`) and v1 prompts in `packages/schemas`; `buildPipelineConfig()` / `seedPipelineConfig`.
- 60 labeled synthetic fixtures (`fixtures/manifest.json`, with dev/calib/test splits), seeded into the demo tenant by `pnpm db:seed`.
- `apps/web`: a read-only `/documents` page (upload, statuses, and a detail view with parts, extraction and gate results).

**Model providers:** besides Claude, configs can use OpenAI, DeepSeek, OpenRouter or a local OpenAI-compatible server (see "Model providers" below). The cassette format is 2 (the hash includes the provider).

**Phase 3 (review) is done:**
- Data layer (`packages/db`): `review.ts` (inbox and counts, `claimNext` with `FOR UPDATE SKIP LOCKED`, `claimTask`, `heartbeat`, `releaseClaim`, `lockTaskForDecision`, user revisions, decisions), `runs.ts` (`startRun` for retry and reclassify runs), `delivery.ts` (the outbox) and `settings.ts` (webhook URL and secret). Migration `0005_review` (decision columns, a tightened claim CHECK) and `0006_review_guards` (triggers: decisions are insert-only, an action's payload is frozen, an extraction changes only when route records its decision once).
- `@ai-triage/core/pipeline`: `proposeAction()` / `approvedPayload()` (one payload shape for auto and human approvals) and `checkUserRevision()`. `@ai-triage/core/review` (web-safe): `fieldDiff()` and `gateFieldMarks()`.
- `apps/api`: `/review/*` (inbox, claim-next, claim, heartbeat, release, `POST /review/tasks/:id/decisions`), `/actions/failed` and `/actions/:id/redeliver`, `/settings/webhook` (admin), and `/documents/:id/email` (sanitized HTML) and `/documents/:id/parts/:index/file`.
- `apps/worker/src/delivery`: signed webhook delivery, the `action.failed` dead letter, and `drainDeliveries()` for tests.
- `apps/web`: a header nav, `/review` (inbox, Processing failed, Delivery failures), `/review/[taskId]` (source with evidence highlights, a form rendered from the category schema, decisions, shortcuts) and `/settings`.
- `webhook-catcher` compose service (`infra/webhook-catcher/catcher.mjs`) on :9030, which verifies signatures. The demo tenant's webhook points at it.

**Cassettes are recorded** (`fixtures/cassettes`, 112 responses from `openai:gpt-6.1-terra` at low effort, $0.18 on 2026-11-03). `recorded.json` is keyed by model ref (`isRecorded(dir, model)`); `--model deepseek:deepseek-flash` records a second set for the eval A/B (not recorded yet). Eval runs replay from the same cassettes: their requests are byte-identical to production's (`evals.e2e.db.test.ts` checks every fixture). The demo tenant, the replay e2e test and the recorder share one model, `DEMO_MODEL` (`packages/db/src/pipeline-config.ts`), because a cassette is keyed by the exact request; changing the model, a prompt, a request builder or a fixture means re-recording (`LLM_MODE=record pnpm cassettes:record --yes`, with `--all` to replace everything). Stop `pnpm dev` first: its replay worker shares the queues. The recorder also re-extracts misclassified fixtures with their labeled category, so a reviewer's natural Reclassify has a cassette; any other reclassify in replay fails as `cassette_missing`.

**Phase 4 (evals) is done:**
- Schema: `0007_evals` (item source title, content key, retire; run item count and error; result score, reasons, grades, error reason) and `0008_eval_guards` (items immutable except retiring once, results insert-only, a run changes only its progress while active, test-split runs need a frozen config).
- `packages/evals` (pure, web-safe): comparators (`exact`, `normalized`, `date`, `amount` within a cent, `set_f1`, `free_text` by presence), `gradeItem()`, run metrics (classification, extraction, routing, cost and latency), `thresholdSweep()`, `reliabilityTable()`, `diffRuns()`, `weightedPrecision()` (1 / audit rate, Kish effective n), and the shared `ResultDetail` / `ProductionMetrics` shapes.
- Data layer (`packages/db`): `evals.ts` (datasets, items, `createEvalRun` with one `eval.item` job per item in the same transaction, `commitEvalResult`, `freezeCalibratedConfig`, `activateConfig`), `configs.ts` (`createCandidateConfig`, `listConfigs`), `metrics.ts` (production metrics in SQL).
- Sources: `packages/ingest/src/eval-source.ts` (`importEvalSource`, `snapshotDocumentSource`) and `apps/worker/src/pipeline/source.ts` (`parseSource`, `loadBlobs`, `stageModel`, `loadCategoryOptions`), shared by the stages and the runner.
- Runner: `apps/worker/src/evals/` (`runEvalItem`, the `eval.failed` dead letter, `drainEvalJobs`). `EvalDeps` has no queue, actions or delivery port.
- API: `/evals/*` and `/configs/*`; "Add to eval set" on approve / edit_approve. Web: `/evals` (Runs, Datasets, Configs, Production), `/evals/runs/[id]` (metrics, sweep, reliability, Freeze), `/evals/diff`.
- Seeds and tools: `seed:evals` (Main dataset from the fixtures, dev / calib / test runs, a DeepSeek candidate once recorded) and `pnpm eval:import`.
- Docker: `Dockerfile` (one image) and compose `init`, `api`, `worker`, `web`: `docker compose up --build` runs the whole demo in replay.

## Repo map

```
apps/api        Hono API (UI REST, public API, webhooks). Exports ./client for web.
apps/worker     pg-boss handlers + cron
apps/web        Next.js UI only (no business logic, no DB access)
packages/db         Drizzle schema + migrations. The ONLY package that imports drizzle-orm / pg.
packages/core       Closed sets (`.`, web-safe) and the pure pipeline (`./pipeline`, Node-only). No I/O.
packages/llm        Model gateway (Claude + OpenAI-compatible providers) + llm_calls recording + replay/record/live
packages/schemas    Category templates, prompts, toApiSchema(), Ajv, rules (a leaf: no workspace deps)
packages/storage    S3 client, presigned URLs, server-issued storage keys
packages/ingest     Ingestion paths: store the source, then create document + run + parse job
packages/evals      Comparators, grading, metrics, threshold sweep, reliability, run diff (pure, web-safe)
packages/contracts  Zod API contracts shared by api and web
docs/architecture.md   Agreed design (source of truth)
fixtures/              Synthetic labeled docs (generated, committed) + LLM cassettes
compose.yaml           Local infra
```

## Commands

```bash
pnpm install                 # Node >= 24, pnpm 12
cp .env.example .env         # already done in a fresh scaffold
pnpm infra:up                # Postgres :5440, RustFS :9020 (console :9021), webhook catcher :9030, creates bucket
pnpm db:migrate              # create the app role, apply migrations, install pg-boss + queues
pnpm db:seed                 # prices, demo tenant (admin@demo.test / reviewer@demo.test, password demo-password), config, 60 fixture docs
pnpm ingest <file>           # .pdf/.docx/.eml/.png/.txt via the REST API (TRIAGE_API_KEY), .json as a Postmark payload
pnpm api-key:create --tenant demo   # prints a tenant API key once
pnpm fixtures:generate       # regenerate fixtures/manifest.json (files are kept unless --force, which invalidates cassettes)
LLM_MODE=record pnpm cassettes:record --yes   # SPENDS MONEY: records missing cassettes (--all re-records, --model <ref> picks the model)
pnpm eval:import <items.jsonl> [--dataset Main]   # labeled files into an eval dataset (origin `import`)
pnpm dev                     # api :8787, web :3000, worker
docker compose up --build    # the whole demo in containers (init seeds; replay mode; no key)
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # must all pass before you're done (pnpm test needs infra:up)
pnpm test:unit               # unit tests only, no Postgres needed
pnpm e2e                     # Playwright demo walkthrough against a running `pnpm dev` (local only, not in CI yet)
pnpm db:generate             # after editing packages/db/src/schema.ts
pnpm format                  # Biome autofix
pnpm infra:down
```

Ports are deliberately non-default (5440, 9020/9021, 8787) to avoid clashing with other local projects. They're configurable in `.env`.

## Conventions

- **Workspace packages ship TypeScript source** (`"exports": "./src/index.ts"`), so they have no build step. The api and worker bundle them with tsup (`noExternal: [/^@ai-triage\//]`), and Next uses `transpilePackages`. Add any new package that web imports to `transpilePackages` in `apps/web/next.config.ts`.
- Internal deps use `"workspace:*"`. Add deps with `pnpm --filter <pkg> add <dep>`.
- **Only `packages/db` imports `drizzle-orm` or `pg`.** A second import site installed a duplicate drizzle-orm (different peer resolution) and broke types. Expose helpers from `@ai-triage/db` instead.
- Env: one root `.env`, loaded with `--env-file-if-exists=../../.env` (tsx/node) or `process.loadEnvFile` (drizzle config). `NEXT_PUBLIC_API_URL` falls back to `http://localhost:8787`.
- API contracts are Zod schemas in `packages/contracts`. The web app calls the API only through the Hono RPC client.
- Biome: 2-space indent, double quotes, 120 columns. Tests sit next to source as `*.test.ts` (Vitest, root config).
- **Database roles.** `DATABASE_OWNER_URL` (the compose superuser) is used only by migrations, seeds and drizzle-kit. The app runs as the role in `DATABASE_URL` (`triage_app`). `pnpm db:migrate` creates that role as a member of the NOLOGIN group `app_rw`, which every grant targets. The api and worker call `assertAppRole()` and refuse to start as a role that bypasses RLS.
- **Tenant data goes through `withTenantTx(pool, tenantId, fn)`.** It sets `app.tenant_id` with `set_config(…, true)`. Outside it, RLS hides every tenant table. A "tenant table" is exactly a public table with a `tenant_id` column: give it `tenantKey()`, reference its parents with three-column (or two-column) composite FKs that include `tenant_id`, and add it to the list in `0002_rls.sql`, or write a new migration that enables RLS for it. `catalog.db.test.ts` fails if you forget.
- **Enums are `text` + CHECK built from `@ai-triage/core` arrays** (`oneOf()` in `schema/_helpers.ts`), not `pgEnum`. The drizzle migrator runs all pending files in one transaction, and a value added with `ALTER TYPE … ADD VALUE` can't be used in that transaction.
- **pg-boss:** runtime instances come from `createBoss()` (no migrate, no reindex, no queue-stat partitions; the app role can't do DDL). New queues go in `QUEUES` in core; `db:migrate` creates them. Enqueue inside a transaction with `enqueue(boss, tx, …)`.
- **Better Auth tables** (`users`, `sessions`, `accounts`, `verifications`, `tenants`, `memberships`, `invitations`) are global, with no RLS. They keep BA's `organization_id` naming, and drizzle export and property names must match BA's model and field names. Public sign-up and user-created orgs are disabled; tenants come from `createTenant()`, and users from `ensurePasswordUser()`.
- Migrations are generated by drizzle-kit. RLS policies and other raw SQL go in hand-written migration files, created with `pnpm --filter @ai-triage/db exec drizzle-kit generate --custom --name=<name>` so they're registered in `_journal.json`. Never edit an applied migration.
- pnpm 12 blocks dependency build scripts by default. Approve one with `pnpm approve-builds <pkg>`, which writes `allowBuilds` in `pnpm-workspace.yaml`.

## Invariants (don't break these; details in docs/architecture.md)

1. **Tenant isolation.** Every tenant table has `tenant_id`, RLS (`current_setting('app.tenant_id')`), and **composite FKs** `(tenant_id, x_id) → parent(tenant_id, id)`. All tenant access goes through `withTenantTx()`. Storage keys are generated by the server, never accepted from clients.
2. **Short transactions.** Never hold a transaction open across a Claude call. The order is read and commit, then call, then commit with revision checks.
3. **Atomic stage commit.** A stage's result, its status advance (`WHERE current_run_id = $run AND processing_status = $expected`) and the next job's enqueue happen in **one transaction**, with pg-boss given that transaction's client (`boss.send(…, { db })`).
4. **LLM attempts.** Each attempt is saved as soon as the response arrives, reused on retry, and exactly one is marked `canonical` per context and stage. Repeat calls are still possible (a crash before the save), so downstream rows must stay deduplicated. `llm_calls` has exactly one execution context: a processing run, or an eval run + item.
5. **Approvals** bind to an exact `extraction_id` revision plus a `claim_token`, and the action payload is frozen at approval. Allowed actions per task kind follow `ACTIONS_BY_TASK_KIND`, enforced by the API. Reclassify invalidates the claim and always returns the item to a human.
6. **Webhooks** are delivered at least once with a stable `Idempotency-Key` (the action id).
7. **Evals can't act.** The eval runner is built without the actions or delivery ports. Eval items never create `documents` rows, and `actions` requires one.
8. **No surprise spend.** `LLM_MODE` defaults to `replay`. A missing cassette is a hard error, never a fallback to a live call. Live mode is opt-in. Budget is reserved atomically. Replayed figures are labeled as recorded, not actual.
9. **Correct auto-approval** means the right category **and** every required field correct. Thresholds are chosen on `calib`, the config is frozen, and only then is `test` run. Always show n and the Wilson bound.

## Claude API notes (checked Nov 2026)

- SDK: `@anthropic-ai/sdk`. Effort levels on all three models: `low`/`medium`/`high`/`xhigh`/`max` (Opus and Haiku default to `medium` if unset, so always set it). Default model is `claude-opus-5-5` at `effort: "low"` (set in `output_config.effort`), configurable per stage in `pipeline_configs`. Alternatives the evals page compares: `claude-sonnet-5-5`, `claude-haiku-5-5`. Use only these exact IDs, with no date suffixes.
- Structured output: `output_config: { format: { type: "json_schema", schema } }`. The raw API can 400 on unsupported keywords (`minimum`/`maximum`/`minLength`/`maxLength`, recursive schemas), so strip them in `toApiSchema()` and enforce the full schema with Ajv. Citations are incompatible with structured outputs.
- Things that changed recently:
  - Thinking can't be disabled on Opus 5.5; effort is the control.
  - `temperature`/`top_p`/`top_k` now return a 400.
  - Assistant prefill isn't allowed.
  - Forced `tool_choice` returns a 400 on Opus/Sonnet 5.5.
- Refusals: always check `stop_reason` before reading content. Use `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`. It isn't available on Batches or Haiku.
- Usage fields for cost: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Prices per MTok (input/output): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (prompts ≤100K tokens; $0.50/$2.50 above). Cache reads are 0.05x input on Opus/Sonnet 5.5 ($0.20/$0.10) and 0.1x on Haiku. Writes are 1.25x (5m) or 2x (1h). Batch is 0.5x. These are seeded in `packages/db/src/seed/prices.ts` (verified 2026-11-03); re-verify before changing them.

## Model providers

- **Model refs.** A bare Claude id (`claude-opus-5-5`) or `provider:model` for the rest: `openai:gpt-6.1-terra`, `deepseek:deepseek-flash`, `openrouter:openai/gpt-6.1-terra`, `compat:qwen3`. `compat` is any OpenAI-compatible server (Ollama, vLLM, LM Studio) at `OPENAI_COMPAT_BASE_URL`. Refs are stored as they are in `pipeline_configs`, `llm_calls.model` and `model_prices.model`.
- **`MODEL_CATALOG`** (`packages/core/src/models.ts`) is the closed set of usable models, with capabilities: `structuredOutput` (`json_schema`, or `json_object` for DeepSeek, whose schema goes in the system prompt and is enforced only by Ajv), `inputs` (`pdf`, `images`) and the `efforts` the model accepts (`none` means no reasoning or no effort control). Config validation checks both the ref and the effort against it.
- **Adding a model:** one `MODEL_CATALOG` entry plus a `MODEL_PRICE_SEED` row (`packages/db/src/seed/prices.ts`). Live calls reserve budget at the model's price, so an unpriced model can't be called. Check ids, capabilities and prices against the provider's docs.
- **Text-only models.** A model without `pdf` input gets a text-layer PDF as per-page text (page-cited evidence still verifies). Scans and images it can't read fail the run as `unsupported_file`.
- **Adapters** live in `packages/llm/src/providers/`: `anthropic.ts` (Messages API) and `openai-compatible.ts` (Chat Completions through the official `openai` SDK with a `baseURL`). Each turns an `LlmRequest` into exact wire params and normalizes the raw response (stop reason in Claude's names, usage by price class). Cassettes hash `{ provider, params }` (`CASSETTE_FORMAT` 2) and store the raw provider response.
- **Keys** live in the deployment `.env` (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPAT_*`). Clients are built on first use, so a key matters only for a provider the active config uses. Replay builds no client.
- **Why not the Vercel AI SDK or `zodResponseFormat`:** output schemas are versioned JSON Schemas stored per tenant, so compile-time Zod types add nothing (Ajv against the full schema is the check). An abstraction SDK would also own the wire format (breaking exact-params cassettes), hide raw usage, fallback hops and refusal details, and could pick forced `tool_choice`, which 400s on Opus/Sonnet 5.5.
- Provider quirks:
  - OpenAI takes `max_completion_tokens`; the others take `max_tokens`.
  - Effort goes as `reasoning_effort` on OpenAI and DeepSeek, and as `reasoning.effort` on OpenRouter (which also gets `provider.require_parameters` so it only routes to upstreams that honor `response_format`).
  - `prompt_tokens` includes cached tokens, so uncached input is the difference (DeepSeek also reports `prompt_cache_hit_tokens`).
  - DeepSeek's prices have peak and off-peak rates; the seed uses peak, so its recorded cost is an upper bound. OpenRouter's seed price is the highest listed upstream, with no cache discount.

- **Core subpaths.** `@ai-triage/core` stays constants-only so web can import it; parsers and pipeline logic live in `@ai-triage/core/pipeline`.
- **Stage commit order:** guarded status advance first (it locks the document row and detects stale or duplicate jobs), then the stage result, then pointers (`current_extraction_id` after the extraction insert: the FK isn't deferrable), then `markCanonical`, then enqueue. Stage jobs get deterministic ids (`stageJobId`), so a duplicate send is a no-op.
- **Failures:** a `PipelineError` (bad file, refusal, `max_tokens`, missing cassette, budget...) fails the run at once; anything else is retried by pg-boss per `QUEUE_OPTIONS`, then dead-lettered to `doc.failed`. `failRun` is guarded on the failing stage's input status.
- **Cassette hashes must not depend on the tenant:** request builders take content and config only (no ids, keys or recipient addresses). A test checks this.
- **Review decisions** go through one endpoint, `POST /review/tasks/:id/decisions` (`apps/api/src/review.ts`), in one transaction that locks the document row and then the task row: the same order as the worker's stage commits, so they can't deadlock. Refusals are `ReviewError(code)`: 409 when the state moved on (`claim_lost`, `stale_revision`, `task_resolved`, `reprocessing`, `claimed_by_other`, `not_redeliverable`), 422 when the request can never apply (`action_not_allowed`, `invalid_fields`, `invalid_category`).
- **Leases have no reaper.** A claim whose `lease_expires_at` has passed counts as no claim everywhere (claim, inbox, decisions), so no maintenance role is needed. Lease time comes from `AppDeps.now`, which tests pin.
- **Retry resolves the `processing_failed` task** (a retry may auto-approve, and route never closes tasks on the auto path); a failed reclassify run is retried as a reclassify. **Reclassify keeps the task** in `awaiting_extraction` until route reopens it as `review`.
- **Delivery failure classes:** a missing URL or secret, a 3xx, and a 4xx other than 408/425/429 fail the action at once; anything else is retried and then dead-lettered to `action.failed`. Redeliver re-enqueues with a fresh job id and the same Idempotency-Key (the action id).
- **Display schemas:** jsonb doesn't keep key order, so the detail API rebuilds a built-in category's schema from its template for the form's field order.
- **Eval runs never act.** The runner gets `EvalDeps` (`pool`, `storage`, `llm`, `limits`, `llmMode`, `now`): no boss, actions or delivery. A type test pins those keys and a source scan rejects `createAction`, `enqueue` and delivery imports under `apps/worker/src/evals/`. The run row and its item jobs are created in one transaction by the API; each item commits its result (and marks its attempts canonical only if the result was stored) under a `FOR NO KEY UPDATE` lock on the run, and the last one finishes the run.
- **Eval items mirror documents.** `source_key` / `source_mime` / `source_title` are stored exactly as ingestion stores a document's source (`EMAIL_SOURCE_MIME` for emails, one object per attachment, the file name verbatim: it goes on the wire as a PDF title), and both paths parse through `parseSource`. Schemas come from `category_schema_versions`, never from templates (jsonb key order feeds the extract prompt). Parse replaces lone surrogates and `parseClassifyOutput` rounds the score to 3 decimals, as the database round trip does.
- **Grading** (`packages/evals`): `required_correct` is the definition of a correct auto-approval (right category and every required field). Grades are stored on the result when written. Errors count as wrong and as review.
- **Test needs frozen.** `createEvalRun` refuses (`config_not_frozen`) and the `eval_runs_test_split` trigger backs it up. Freeze creates a child version (`createCandidateConfig` + `freezeConfig`; never `buildPipelineConfig`, which activates). Activation requires frozen.
- **LLM modes** (`LLM_MODES`, `getLlmMode`, `callModeOf`) live in core so the api reads them without loading SDKs; `@ai-triage/llm` re-exports them. A run stores the mode it expects; the worker fails a run whose mode differs from its own.
- **Web in Docker:** server components call the API at `API_INTERNAL_URL` (compose: `http://api:8787`); the browser uses `NEXT_PUBLIC_API_URL`, inlined at build time.
- **Fixtures are generated once and committed;** cassettes are keyed by their exact bytes. Random draws in the generator must happen outside the file-writing callbacks.

## Gotchas found while scaffolding

- MinIO no longer publishes community Docker images, so local S3 is **RustFS** (`rustfs/rustfs`). The bucket is created with `curl --aws-sigv4`.
- `docker compose up --wait` treats an exited one-shot service as a failure, so `infra:up` waits only on the long-running services and then runs `storage-init` with `run --rm`.
- TypeScript 7 (native compiler) is in use, and Next 16 builds and typechecks fine with it.
- tsup bundles CommonJS deps such as `pg` into the ESM output, so `apps/api` and `apps/worker` add a `createRequire` banner. Without it, `node dist/index.js` crashes with "Dynamic require of "events" is not supported".
- Better Auth's `disableSignUp` also blocks server-side `auth.api.signUpEmail`, so seeds and tests create users with `ensurePasswordUser()`, which mirrors BA's credential rows.
- Better Auth with `generateId: "uuid"` leaves `id` out of inserts, so every auth table needs `uuid().defaultRandom()`.
