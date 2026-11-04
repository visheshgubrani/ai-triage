# Architecture

> Agreed design for ai-triage. This is the source of truth for what gets built; AGENTS.md summarizes the invariants.


## Context

This is an open-source, multi-tenant app. Emails and documents come in, an LLM classifies each one and extracts structured fields (validated JSON Schema), and anything uncertain goes to a human approval queue instead of being acted on. An evals page reports accuracy per category plus cost and latency per request, so thresholds and model choices rest on measured data.

It is an **MVP, open source, and a portfolio project**. The goals are: correct where correctness is cheap (retries, approvals, tenant isolation, honest eval numbers), runnable by a stranger in one command without an API key, and easy to read as a showcase. Anything that is only enterprise hardening is deferred to "Later".

Stack: **TypeScript monorepo, Hono API + Next.js UI, Postgres (RLS) + pg-boss, S3-compatible storage (RustFS locally), Claude API**, deployed as containers. v1 ingestion is email forwarding (Postmark inbound) plus uploads and a REST API.

### What changed after review
| Review point | MVP decision |
|---|---|
| Retries can repeat paid calls; stage writes not atomic | Each LLM response is persisted as soon as it returns and **reused on retry**. This narrows repeat calls but can't rule them out (§5). Saving a stage's result and enqueueing the next job happen in **one transaction**, with pg-boss given that same transaction's client through its `db` adapter. |
| Approvals can act on stale data | Approvals bind to an **exact extraction revision** plus a **claim token**. The action payload is frozen at approval time. |
| Webhooks can be delivered twice | At-least-once delivery, with a stable `Idempotency-Key` that receivers must honor (documented in the README). |
| Calibration and test data overlap | Three splits: **dev / calib / test**. Thresholds are picked on calib, the config is frozen, then it runs once on test. Every rate is shown with its n and a 95% Wilson lower bound. |
| Extraction confidence was never produced | The score is defined explicitly (§6). Extraction contributes through gates, not a multiplied number, and a reliability table checks whether the score is actually useful. |
| Review corrections miss mistakes in auto-approved items | A random **audit sample** of auto-approvals is held for review, which gives an unbiased production precision estimate. |
| PDF evidence mismatch | Evidence handling is defined per source type. Scans and images can't be verified, so they **always go to review** (OCR comes later). |
| RLS alone isn't enough | **Tenant-scoped composite FKs**, server-issued storage keys, and ownership checks on upload, download, review and actions. Transactions stay short. |
| Eval could dispatch real actions | It is structurally impossible: actions need a `documents` row, and eval items never create one. |
| Failure paths unclear | Status is split into processing, review and delivery, and every exceptional transition is written out in §5. |
| Postmark / API details | Basic auth over HTTPS (Postmark doesn't sign webhooks), and the parsed JSON payload is stored as the source of record. Unsupported schema keywords are stripped before calling the API (the raw API can 400 on them) and then enforced with Ajv. 32 MB / 100 pages is an *app* limit. |
| *Round 2:* the crash window remains | Every attempt is recorded and one **canonical** result is chosen per run and stage. The remaining window is documented, and there are tests for both crash cases. |
| *Round 2:* eval calls have no processing run | `llm_calls` has exactly one execution context, either a processing run or an eval run + item, enforced with a CHECK. |
| *Round 2:* tasks without an extraction | `extraction_id` is nullable for those kinds, there is a fixed action list per task kind, and reclassify invalidates the claim and always returns to a human. |
| *Round 2:* quickstart and replay | `docker compose up --build` does everything and the demo defaults to replay. A missing cassette is a hard error, and replay figures are labeled as recorded. |
| *Round 2:* correctness and budget | A correct auto-approval means the right category **and** every required field correct. Audit precision is per category (weighted when combined). Budget is reserved atomically. |

---

## 1. System shape

```
 Postmark inbound ─┐                                     ┌─> Next.js: inbox · review · evals · settings
 Upload (2-step)   ├─> Hono API ─tx─> Postgres (RLS) <───┤   (Hono RPC typed client)
 REST API / CLI   ─┘    insert doc + enqueue (same tx)    │
 Gmail (sync) ─────> worker: poll → history → fetch ──────┤   (per-mailbox OAuth, read-only)
                        │                                 │
                  RustFS/S3 (server-issued keys)          │
                        ^                                 │
 pg-boss ──> worker: parse → classify → extract → route ──┼─> auto (+not sampled) ─> actions outbox ─> signed webhook
                         │ LLM response saved immediately └─> review / audit ─> human ─> actions outbox
                         v
                   model API       (eval runner: same core, results → eval_results only)
```

Three processes from one image (`web`, `api`, `worker`), plus Postgres and RustFS in docker-compose. The model API is Claude or any OpenAI-compatible provider (§5); the demo replays GPT-6.1 Terra.

**Why pg-boss over QStash:** jobs are enqueued in the same transaction as the data that triggers them, and only when the transaction's client is passed to `boss.send(…, { db })`; sharing a database isn't enough on its own. It also means no public worker endpoints, no HTTP timeouts on slow LLM or PDF work, built-in retries, cron and dead-lettering, and stuck jobs you can find with SQL. The queue sits behind a small `Queue` interface.

---

## 2. Repo layout (pnpm + Turborepo, MIT license)

```
apps/web        Next.js App Router (UI only)
apps/api        Hono on Node: UI REST, public API (tenant API keys), Postmark webhook, upload flow
apps/worker     pg-boss handlers: pipeline stages, webhook delivery, mailbox sync, evals, maintenance
packages/db         Drizzle schema, RLS + composite-FK migrations, withTenantTx(), seeds
packages/core       closed sets, and the pure pipeline (./pipeline): parse, classify, extract, verifyEvidence, gates, route
packages/llm        model gateway (Claude + OpenAI-compatible adapters): call → llm_calls (tokens, cost, latency); live | record | replay modes
packages/schemas    category templates (Zod) → JSON Schema; toApiSchema(); Ajv validators
packages/storage    S3 client, presigned URLs, server-issued storage keys
packages/ingest     ingestion paths: store the source, then create document + run + parse job
packages/evals      comparators, metrics, Wilson interval, threshold sweep, run diff
packages/mailbox    mail providers: Google OAuth and Gmail REST over an injected fetch, plus a fake Google
packages/contracts  Zod API types shared by api + web
fixtures/           synthetic emails/PDFs/scans per category (+ ambiguous, injection); LLM cassettes
infra/              webhook-catcher (a local receiver that verifies signatures)
Dockerfile          one image for api, worker, web and the one-shot init
```

**OSS ergonomics:**
- **The quickstart is `docker compose up`** (it pulls the prebuilt image, or builds it). A one-shot `init` service runs migrations, creates the storage bucket and seeds the demo tenant (around 60 synthetic documents and a labeled dataset with splits), and it is idempotent. `api`, `worker` and `web` wait for it with `depends_on: condition: service_completed_successfully`. The demo runs in **replay mode**, so the evals page is populated and no API key is needed.
- **`LLM_MODE` is explicit.** `replay` (the default) serves cassettes from `fixtures/cassettes`, keyed by request hash. **A missing cassette is a hard error** (`CassetteMissError`, naming the hash and the record command), never a silent fallback to a paid call. `record` calls the live API and writes cassettes. `live` has to be set on purpose.
- The contributor dev loop is `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:seed`, then `pnpm dev`. `pnpm ingest <file>` pushes an .eml, PDF or JSON file through the real ingestion path.
- **One origin:** the API is served under `/api` on the web app's origin (`PUBLIC_URL`). In containers Caddy routes `/api/*` to the api and the rest to web; `pnpm dev` uses a Next rewrite instead (never in containers: Next's proxy caps bodies at 10 MB, times out at 30 s and can't vouch for X-Forwarded-For). Server components call the API directly at `API_INTERNAL_URL` (compose: `http://api:8787`). So no URL is baked into the image, and session cookies work on any hostname. `/health` and the machine routes (`/webhooks`, `/v1`) also answer at the root, for probes and older integrations.
- **Fixtures** are generated once and committed, and cassettes are keyed by the exact request bytes, so fixtures don't change casually. Providers, modes and recording are in [llm.md](llm.md).
- The README carries the architecture diagram, an evals screenshot, a "design decisions" section and a "known limits" section (repeat model calls, what evidence matching proves, injection).

---

## 3. Tenant isolation

- `tenant_id` on every tenant table, plus **RLS** (`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`, ENABLE + FORCE) with the app connecting as a non-owner role. The NULLIF matters because a pooled session reports `''` after a `SET LOCAL` ends. With no tenant set, queries see no rows.
- **Roles:** migrations and seeds run as the owner (`DATABASE_OWNER_URL`). The app's login role (`DATABASE_URL`) is created by `db:migrate` as a member of the NOLOGIN group `app_rw`, which every grant targets (DML on all tables, read-only on `model_prices`, DML and EXECUTE on schema `pgboss`). The api and worker refuse to start as a role with `rolsuper` or `rolbypassrls`. The app role also has `idle_in_transaction_session_timeout = 30s`, which backs the short-transaction rule. A test lints the catalog: every tenant table has RLS and a policy, and every FK between tenant tables carries `tenant_id` in the same position on both sides.
- **Composite FKs:** parent tables declare `unique (tenant_id, id)`, and children reference `(tenant_id, document_id) → documents(tenant_id, id)`. A cross-tenant reference fails at the database even if the code has a bug.
- `withTenantTx(pool, tenantId, fn)` takes one `pg` PoolClient, runs `BEGIN` and `set_config('app.tenant_id', $1, true)` (a parameterized `SET LOCAL`), and gives `fn` both a Drizzle handle and a pg-boss `db` adapter (`executeSql` on the same client). Workers take the tenant from the job payload. No role bypasses RLS: an expired review lease counts as no claim in every query (§7), so there is no reaper and no maintenance role.
- **Lookups before tenant context** (Postmark inbound address → tenant, API key hash → tenant) go through narrow `SECURITY DEFINER` functions, added in phase 2. They're owned by a NOLOGIN `app_resolver` role with a `FOR SELECT TO app_resolver USING (true)` policy on just those tables, because FORCE RLS also binds a non-superuser owner.
- **pg-boss** is installed and upgraded by `db:migrate` as the owner, which also creates every queue (`QUEUES` in core; `send()` refuses unknown queues). Runtime instances run as the app role with `migrate`, `createSchema` and `reindex` off. Queues stay non-partitioned.
- **Storage:** the client never supplies a key. `POST /uploads` creates an `uploads` row with a server key (`t/{tenant}/u/{uuid}`), an expiry and a presigned PUT. `POST /uploads/:id/complete` checks the row belongs to the tenant, HEADs the object to confirm size and mime, then creates the document. Downloads go through `GET /documents/:id/source`: the RLS-checked lookup returns a short-lived presigned GET.
- Review decisions and actions resolve every referenced id inside the tenant transaction. Webhook targets come only from tenant settings.
- **Short transactions:** read under the tenant context and commit, call Claude with no transaction open, then commit the result with revision checks.
- Auth: Better Auth with the organizations plugin, whose organization *is* the `tenants` table (`modelName` renames: `users`, `sessions`, `accounts`, `verifications`, `tenants`, `memberships`, `invitations`, all with uuid ids). These auth tables are global (no RLS) and keep BA's `organization_id` naming. Roles are `admin`, `reviewer` and `viewer`. Public sign-up and user-created organizations are disabled. The API mounts only the Better Auth endpoints the web uses (sign-in/out, session, password, sessions list/revoke, TOTP 2FA); admin-only routes require the admin's 2FA when `REQUIRE_ADMIN_2FA` is on. Tenants are created by `createTenant()` (tenant, settings and inbound address in one transaction). A new session lands in the user's first tenant, and the API re-checks membership on every request.
- **Google and members (phase 6):** one Google OAuth client serves Sign in with Google (Better Auth; identity only, the Google tokens are dropped) and mailbox connections ([google.md](google.md)).
  - **Admission:** Better Auth may create a user only through `admissionRefusal()` (`packages/db/src/admission.ts`, the `user.create.before` hook): a verified Google email that holds a pending invitation, or a Workspace account whose `hd` a tenant claimed for auto-join.
  - **Linking:** a Google sign-in joins an existing user only when Google verified the email and so did we. Google isn't a Better Auth "trusted provider".
  - **2FA:** a Google sign-in asks for TOTP like a password sign-in (`auth-oauth-2fa.ts`). A Google-only user changes 2FA with a sign-in from the last 10 minutes instead of a password.
  - **Invitations** (`members.ts`) are copyable links `/invite#<token>`: only the token's SHA-256 is stored, and each works once within 7 days and can be revoked. Accepted with Google (the verified email must match), or with a password when the admin allows it (that user stays unverified, so Google can't take the account over). `pnpm tenant:create` makes a tenant with a default config and its first admin's link.
  - **Members:** role changes and removal keep at least one admin, under a lock on the tenant's admin memberships.
  - **First run (phase 7):** while no tenant exists, the api keeps a one-time setup token (its SHA-256 in the global `installation` table, valid 24 h) and logs `<PUBLIC_URL>/setup#<token>`; `pnpm setup-link` prints a fresh one. The setup page posts it to `POST /api/setup`, which claims it once (and refuses if any tenant exists by then), then calls `createWorkspace()`: the same as `tenant:create`, with the tenant, a default config and an admin invitation. The page continues at the invite link, so no new sign-up path exists.
  - **Getting started:** `GET /api/onboarding` derives a checklist from the tenant's own data: whether a running worker can run the active config (heartbeats report each worker's keys, simulator and recordings), intake, a first document, a verified webhook (Send test event: a signed `ping`), the team, an eval set, and calibrated automation. Only its dismissal is stored.
  - **Workspace domain:** claimed by signing in to a Workspace account in it (`hd=*`; the domain is the ID token's `hd`), with one tenant per domain. New users from it join as viewer or reviewer at creation only.

---

## 4. Data model (key tables)

| Table | Notes |
|---|---|
| `tenants`, `users`, `sessions`, `accounts`, `verifications`, `memberships`, `invitations` | Better Auth's tables (global, no RLS); `memberships.role` ∈ admin/reviewer/viewer |
| `tenant_settings` | PK `tenant_id`: `active_config_id`, webhook URL, the signing secret **encrypted** (`webhook_secret_enc`, AES-256-GCM with the tenant id as AAD) and the previous one during a rotation's grace period, `daily_llm_cap_usd` |
| `api_keys` | `key_hash` unique, `prefix`, `revoked_at` |
| `inbound_addresses` | `address` unique → tenant |
| `uploads` | server-issued `storage_key`, expected size/mime, `expires_at`, `completed_at` |
| `documents` | `source`, `external_id` (Message-ID header, else Postmark MessageID, else content hash), unique `(tenant_id, source, external_id)`, `source_key`, **`processing_status`**, **`review_status`**, **`delivery_status`**, `current_run_id`, `current_extraction_id` |
| `document_parts` | text with offsets, or per-page PDF text, plus `evidence_mode` (`text`/`pdf_text`/`unverifiable`) |
| `pipeline_configs` | **immutable versions** (triggers): model ref (a `MODEL_CATALOG` key, e.g. `claude-opus-5-5` or `deepseek:deepseek-flash`), effort and prompt version per stage as explicit columns, `policy`, `parent_id`. The only allowed update sets `frozen_at` once, after calibration. `tenant_settings.active_config_id` points at the active one |
| `pipeline_config_categories` | per config and category: `schema_version_id` (a composite FK that also matches the category), `threshold`, `automation`, `audit_rate`. Insert-only, and closed once the config is frozen |
| `category_schema_versions`, `prompt_versions` | immutable |
| `processing_runs` | document, `config_id`, trigger (`ingest`/`retry`/`reclassify`), `forced_category`, status, `superseded_by` |
| `llm_calls` | **one row per attempt**. Execution context is **either** `processing_run_id` **or** `eval_run_id` + `eval_item_id`, with a CHECK that exactly one is set. stage, attempt, **`canonical`** (partial unique index: one canonical success per context and stage), **`mode` (`live`/`replay`)**, model, effort, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd`, `price_id`, `latency_ms`, `stop_reason`, `served_by_fallback`, `request_id`, **`response` jsonb**, error |
| `classifications` | run, category, `self_confidence`, rationale |
| `extractions` | **revisions**: document, run (null if a human wrote it), `revision`, `author` (`model`/`user`), `parent_id`, `fields`, `validation_errors`, `gate_results`, `score`, `decision`, `decision_reasons[]`; unique `(document_id, revision)` |
| `review_tasks` | document, `kind` (`review`/`audit`/`processing_failed`/`unclassified`), `extraction_id` (**nullable**; a CHECK requires it when kind is `review` or `audit`), reasons, status (`pending`/`claimed`/`awaiting_extraction`/`resolved`), `claimed_by`, **`claim_token`**, `lease_expires_at` |
| `review_decisions` | reviewer, outcome, `task_kind` (the task's kind when decided), `extraction_id` (the revision decided on, or the one an edit produced), `before`, `after`, diff, note. **Insert-only** (trigger): the review queue's audit trail |
| `actions` | document (NOT NULL), **`extraction_id`** (unique), **frozen `payload`** (a trigger allows only the delivery columns to change), status, attempts, `last_error`. The action `id` is the `Idempotency-Key` |
| `tenant_settings.retention_days` | Finished documents older than this are purged by the nightly `system.maintenance` job (null keeps them). Deletion goes only through `purge_document()` (0016_purge.sql), owned by `app_purger`, the one role the immutability guards let delete |
| `audit_events` | Security-relevant changes per tenant: actor (user / API key / system), action (`AUDIT_ACTIONS`), target, `details` (never secrets), ip, user agent, request id. Written in the same transaction as the change; **insert-only** (no UPDATE/DELETE grant, plus a trigger). Review decisions keep their own trail |
| `oauth_states` | One OAuth round trip started by an admin (mailbox or Workspace domain): the `state`, PKCE verifier, used once by the same user within 10 minutes |
| `mailbox_connections` | A connected mailbox: provider, address, status (`active`/`paused`/`reauth_required`/`disconnected`), intake label, **encrypted** refresh and access tokens (AAD `${tenant}:mailbox:${id}`), the history cursor with a CAS `cursor_version`, `next_sync_at`. Unique per tenant, provider and address |
| `mailbox_messages` | The sync ledger: one row per message seen (`queued`/`ingested`/`duplicate`/`skipped`/`deferred`/`failed`/`purged`) with a reason and `document_id`. Ids only, no content; purging a document leaves a `purged` tombstone |
| `tenants.workspace_domain` | Auto-join domain (unique) and `workspace_join_role` |
| `model_prices` | per model and prompt-size tier (`prompt_tokens_above`): per-MTok input, output, 5m and 1h cache write, cache read; batch multiplier; `effective_from`. Global and read-only for the app |
| `llm_budget_days` | `(tenant_id, day)` → `cap_usd`, `spent_usd`, `reserved_usd` |
| `eval_datasets`, `eval_items` | immutable source snapshot (`source_key`, `source_mime`, `source_title`, stored exactly as a document's source), `content_key` (derived like `external_id`; unique per dataset among active items), `expected_category`, `expected_fields`, **`split` (`dev`/`calib`/`test`)**, origin and `origin_ref`, tags, `retired_at` (set once; items are otherwise immutable). No link to `documents` |
| `eval_runs`, `eval_results` | run: `config_id`, split, `llm_mode`, status, `item_count`, aggregates, error; only progress changes while active, and a **test-split run requires a frozen config** (trigger). Result (insert-only): predicted category and fields, score, decision, reasons, gate results, field scores and the three grades (`category_correct`, `required_correct`, `fully_correct`), **`proposed_action`** (stored, never sent), cost, latency, canonical llm_call ids, error and `error_reason` |

Enum-like columns are `text` with a CHECK built from the `as const` arrays in `packages/core` (no `pgEnum`, because drizzle's migrator runs pending migrations in one transaction). Pointers to rows of the same document (`current_run_id`, `current_extraction_id`, and `extraction_id` on tasks and actions) use three-column FKs `(tenant_id, document_id, x_id)`, so a document can't adopt another document's run or extraction.

---

## 5. Pipeline and state transitions

**Ingestion (API).**
- **Postmark:** basic auth credentials in the HTTPS webhook URL (optionally an IP allowlist). The parsed JSON payload is stored as `source.json`, and attachments are decoded into separate objects.
- **Uploads:** the two-step flow in §3.
- **REST/CLI:** the same path, authenticated with a tenant API key.
- **Gmail sync (phase 6):** a minute cron (`mailbox.poll`) lists due mailboxes through the SECURITY DEFINER resolver `due_mailbox_connections()` and enqueues one `mailbox.sync` each (an `exclusive` queue).
  - **Sync:** reads the cursor, then asks Gmail's history for messages added to the intake label (or labelled into it) with no transaction open. It then commits, in one transaction: the cursor (CAS on `cursor_version`), the new ledger rows, and one `mailbox.fetch` per new message (deterministic job ids).
  - **Expired cursor:** about a week of history is kept. A 404 reads the profile's `historyId` first, then lists recent mail within the label (at most 7 days back).
  - **Dead grant:** an `invalid_grant` marks the mailbox `reauth_required` (audited), and polling stops.
  - **Fetch:** downloads the raw message. Drafts, sent mail, spam, trash, deleted and oversized mail are skipped with a reason. Over the tenant's inbound limit (shared with Postmark) a message is deferred. Otherwise it's ingested like an `.eml` (`source = gmail`, raw kept as `source.eml`), with the ledger row committing with the document (`ingestEmail`'s `within`).
- In every case, inserting the document, creating `processing_run` #1 and enqueueing `doc.parse` happen in one transaction. A duplicate `external_id` returns 200 and does nothing.

**Intake filters (phase 7):** some mail is noise by its headers alone: auto-replies (RFC 3834 `Auto-Submitted`, `X-Autoreply`, `Precedence: auto_reply`), bounces and read receipts (`multipart/report`), and bulk mail (`List-Id`, `List-Unsubscribe`, `Precedence: bulk`).
- Normalization records these signals with the stored email, only when present; the model never sees them.
- On a document's first run, the parse stage checks them against the tenant's filters (`tenant_settings.intake_filters`): auto-replies and bounces on by default, bulk off. A match ends the run before any model call: `processing_status = skipped`, `processing_runs.skip_reason`, no review task.
- **Process anyway** (`POST /api/documents/:id/process`) is a retry, which the filters never apply to.
- Headers, never content, so a sender can't talk a message past them; and eval items, which don't run the parse stage's filter, are unaffected.

**Each stage handler (parse → classify → extract → route) follows the same three steps:**
1. **Read.** In a short transaction, load the run and its inputs. Stop if the run is superseded or the stage is already done.
2. **Call.** If a successful attempt already exists for `(context, stage)`, reuse it. Otherwise reserve budget (live mode only; see below), call Claude, and **insert the attempt row, response included, in its own small transaction right away**. This narrows repeat calls but can't remove them: if the worker crashes between Claude returning and that insert, the retry calls Claude again. The README says so plainly: *repeated model calls are possible, and saved responses are reused whenever available.* Every attempt is kept for cost accounting.
3. **Commit.** In one transaction: advance status with `WHERE current_run_id = $run AND processing_status = $expected` (first: it locks the document row), write the stage result, update pointers such as `current_extraction_id` (after the insert, since that FK isn't deferrable), mark the attempt used as `canonical`, then enqueue the next job through the same client (stage jobs have deterministic ids, `stageJobId`, so a duplicate send is a no-op). If the guard matches nothing, the run is stale and the handler exits. Stage results are unique per run and stage, and actions are unique per approved revision, so a repeated model call can never produce a second extraction or a second action.

**Parse.**
- Email bodies become plain text with offsets. DOCX goes through `mammoth`.
- PDFs go through `unpdf` to get per-page text. If the text layer is substantial, `evidence_mode = pdf_text`; otherwise it's a scan and `evidence_mode = unverifiable`. Images are always `unverifiable`.
- The PDF or image itself is still sent to Claude as a document or image block, so the model sees the layout.
- App limits: `MAX_FILE_MB=20`, `MAX_PDF_PAGES=100` (configurable). Inline PDFs and images are base64-encoded (4/3 larger) and a request may not exceed 32 MB, so the request builder also refuses documents over 30 MB once encoded (`request_too_large`).
- A PDF counts as text (`pdf_text`) when it averages at least 40 non-whitespace characters per page; otherwise every page is `unverifiable`.

**Classify** returns `{ category: enum(tenant categories + "other"), self_confidence: 0..1, rationale }`.

**Extract** returns, for each field, `{ value, evidence: { quote, page? } | null }`, plus `uncertain_fields: string[]`. The schema comes from `toApiSchema()`.

**Route** is pure: gates, then score, then a decision and a proposed action (§6). Extract stores the field values and Ajv errors; route recomputes validation, rules and evidence from the canonical extract response and writes `gate_results`, `score`, `decision` and `decision_reasons` onto that extraction. Production persists the decision. If the result is auto and the item isn't picked for audit, it creates the `actions` row and enqueues `action.deliver` in the same transaction. Otherwise it creates a `review_tasks` row.

**Exceptional transitions:**
| Situation | Result |
|---|---|
| Parse or LLM fails after retries (or a 400 or refusal) | `processing_status=failed`, review task `processing_failed`. The reviewer can **Retry** (new run) or **Reject** |
| Category is `other` | Extraction is skipped and `processing_status=done`. A review task of kind `unclassified` lets the reviewer **Reclassify** or **Reject** |
| Reviewer reclassifies (only while review is pending) | In one transaction: a new run with `forced_category` starts at extract, the old run is marked superseded, and the task moves to `awaiting_extraction` with its claim cleared, so it can't be approved. When the new extraction lands, the task goes back to `pending` as kind `review` and **always to a human**: runs triggered by a reclassify skip auto-routing |
| Reviewer retries | In one transaction: a new run starts from parse (a failed reclassify run is retried as a reclassify, with the same category), the failed run is linked through `superseded_by`, and the `processing_failed` task is resolved, since the new run may auto-approve. If it needs a human, it opens a new task |
| Reviewer edits | A new extraction revision with `author=user` and `parent_id` = the revision shown. The edited values must pass Ajv against the full schema (else 422 and nothing is written); category rules are recorded but don't block. Extractions are otherwise immutable (trigger): route may record its decision once |
| Approve | `review_status=approved`, plus an action with a frozen payload for that exact revision |
| Reject | `review_status=rejected`, which is terminal. No action is created and `delivery_status` stays `none` |
| Delivery exhausts its retries | `delivery_status=failed`. The item shows in a "Delivery failures" filter with manual **Redeliver** (same idempotency key). The review outcome doesn't change |

**Failure classes:** a `PipelineError` (bad file, refusal, `max_tokens`, missing cassette, budget, …) fails the run at once. Anything else is retried by pg-boss per `QUEUE_OPTIONS`, then dead-lettered to `doc.failed`. `failRun` is guarded on the failing stage's input status, so a stale job can't fail a newer run.

**Fairness and backpressure (phase 7):**
- **Fairness:** every tenant job is sent with its tenant as its pg-boss group (`enqueue`, `enqueueMany`, `sendTenantJob` in `boss.ts`, the only send path; a source scan checks). With `WORKER_TENANT_CONCURRENCY` set, the stage, delivery and Gmail fetch queues run at most that many of one tenant's jobs at once across the cluster (`groupConcurrency`, enforced in pg-boss's fetch query), so a quiet tenant's document starts while a noisy one's backlog waits. Eval items have their own cap. It's a cap, not a fair scheduler, and off for one company.
- **Backpressure:** a 429, 529 or 503 from a provider records a cooldown for that model in `llm_provider_state` (global): the provider's Retry-After, or a backoff that doubles per busy answer up to 5 minutes. Before reserving budget, a live call checks it. If the cooldown ends within 20 s, it waits (watching the job's signal). Otherwise it throws `ProviderCoolingDownError` without calling or saving an attempt, and pg-boss retries the job. Classify and extract retry 10 times with backoff capped at 5 minutes, about an hour, before failing as `provider_unavailable`. The first answer after a cooldown clears it.
- **Inbound limits:** a Postmark redelivery is answered before the rate limit counts it. A Gmail message over the tenant's inbound limit is deferred in one transaction (ledger row and the next job, with a deterministic id), wakes with jitter, and gives back the count its refused attempt took.

**Self-healing (phase 7):** every five minutes, `system.reconcile` asks the `stale_work()` resolver for in-flight work unchanged for `RECONCILE_STALL_MINUTES` (default 30): documents mid-pipeline, pending actions, running eval runs. It returns ids only. Each one is then checked against `pgboss.job` in its tenant's transaction:
- A **document** is stalled when neither its stage job (`stageJobId`) nor that job's dead-letter copy (`source_id`) is `created`, `retry` or `active`. `failRun(…, "stalled")` sends it to Processing failed, guarded on status, so a stage committing at the same moment wins.
- An **action** with no delivery or dead-letter job fails with `delivery_stalled`, and shows under Delivery failures with Redeliver.
- An **eval run** with no item jobs left fails.

pg-boss keeps finished job ids for 7 days and ignores a re-send, so the reconciler never re-sends; Retry starts a new run with new ids. `doc.failed` itself never returns silently: without its source queue, it fails the run at its current status. **Retry all** (`POST /api/review/retry-failed`, admins) retries every open, unclaimed `processing_failed` task, optionally of one reason, each in its own transaction exactly as a reviewer's Retry (up to 500 at a time, one audit event). A failed reclassify run whose category was since removed is retried as a plain run.

**Observability (phase 7, [operations.md](operations.md)):**
- **Logs:** JSON lines, one per request, job and model call. Each carries a trace id: the api's request id goes into every job it enqueues (`enqueue` adds the current trace, packages/telemetry), and every job runs under it.
- **Metrics:** Prometheus at the worker's `:9100/metrics` and the api's `/api/metrics` (behind `METRICS_TOKEN`): jobs, queue depth and oldest age, model calls, tokens, cost, cooldowns, pool, HTTP.
- **Health:** `/api/ready` checks the database, migrations and storage; the worker's `/health` follows its heartbeat loop.
- **Heartbeats:** workers upsert `worker_heartbeats` every 15 s, so the web warns everyone when none is running.
- **System health:** Settings → System health shows a tenant its own pipeline, plus the deployment facts every tenant shares (workers, cooldowns).

**Timeouts (phase 7):** nothing waits forever.
- **Model calls:** a per-stage timeout (`llmTimeoutMs`: classify 120 s, extract 60 s plus `max_tokens`/40, at most 600 s). The SDK retries nothing; pg-boss owns retries, with capped backoff (`retryDelayMax`). Each stage's `expireInSeconds` outlasts its longest call (a test checks the margin), so an expired job never runs alongside its retry. The handler passes `job.signal` to the SDK, so an expired job also stops paying for its call.
- **Dead workers:** stage jobs heartbeat every 15 s (`heartbeatSeconds: 30`), so a job whose worker died retries within 30 s, not at its expiry.
- **Parsing:** files are parsed in a `worker_threads` sandbox bounded by `PARSE_TIMEOUT_MS` and `PARSE_MAX_MEMORY_MB`; an overrun fails the run as `parse_timeout`. The thread runs core's parsers unchanged, so requests are byte-identical.
- **Database:** the app role has `statement_timeout = 60s`, `lock_timeout = 15s` and `idle_in_transaction_session_timeout = 30s`; a pool waits at most 10 s for a connection.
- **Storage and HTTP:** S3 requests time out (5 s connect, 60 s request, 3 attempts); the api times out slow clients (30 s headers, 120 s request).
- **Shutdown:** on SIGTERM the worker stops fetching, lets running jobs finish for `WORKER_SHUTDOWN_GRACE_MS`, then aborts their model calls so they retry elsewhere; the api drains for up to 10 s.

**Actions by task kind** (enforced by the API, not only the UI):
| Task kind | Available actions |
|---|---|
| `processing_failed` | Retry, Reject |
| `unclassified` | Reclassify, Reject |
| `review`, `audit` | Approve, Edit & approve, Reclassify, Reject |

**Approval check (one transaction):** the document row and then the task row are locked (the worker's order, so they can't deadlock). The task must be claimed by this user, `claim_token` must match, the lease must be valid, and `extraction_id` must equal `documents.current_extraction_id`. Any mismatch returns 409 with a `code` and the UI reloads; an action outside the task kind's list returns 422. An expired browser tab can't approve. Every decision goes through `POST /review/tasks/:id/decisions` (`apps/api/src/review.ts`). Refusals are `ReviewError(code)`: 409 when the state moved on (`claim_lost`, `stale_revision`, `task_resolved`, `reprocessing`, `claimed_by_other`, `not_redeliverable`), 422 when the request can never apply (`action_not_allowed`, `invalid_fields`, `invalid_category`).

**Delivery:** a POST of the frozen payload with `Idempotency-Key` (the action id), `X-Triage-Event` and `X-Triage-Signature: t=<unix>,v2=<hex HMAC-SHA256(secret, "<t>.<idempotency key>.<body>")>` (one `v2` per secret during a rotation), at least once, with no transaction open during the call. Redirects aren't followed.
- A 2xx delivers it. A missing URL or secret, a 3xx, or a 4xx other than 408/425/429 fails the action at once.
- Anything else (5xx, 408/425/429, timeouts, network errors) counts an attempt and is retried by pg-boss with backoff, then dead-lettered to `action.failed`, which marks it failed.
- **Redeliver** (failed or delivered actions) re-enqueues with a fresh job id and the same Idempotency-Key; `actions` keeps one row.
- The webhook URL and secret come only from tenant settings (admins). The secret is shown once, when created or rotated; a rotation keeps the old one signing for 24 h.
- **SSRF guard** (`checkWebhookUrl`, `isAllowedAddress` in `@ai-triage/core/pipeline`): https only, no credentials, port 443/8443/>1023, and every resolved address public unicast. The API checks DNS when the URL is saved; the worker's fetch resolves through a guarded lookup at every connection (DNS rebinding). `WEBHOOK_ALLOWED_HOSTS` (hostnames or CIDRs) admits private receivers; `TRIAGE_DEMO` admits localhost and the catcher. A blocked URL fails the delivery at once; network errors are stored generically ("connection failed"), and at most 4 KiB of a response is read. The README documents the receiver contract.

**Claude calls (`@anthropic-ai/sdk`):**
- `messages.create` with `output_config.format` json_schema, sent the stripped schema. Ajv then validates the **full** schema.
- Model and effort come from the config. The default is `claude-opus-5-5` at `effort: "low"` for both stages, and the evals page compares alternatives such as `claude-sonnet-5-5` and `claude-haiku-5-5`.
- `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), with a `stop_reason` check before reading content.
- The system prompt (instructions, category definitions, few-shot examples) is cached; the document comes after it.
- **Budget:** a daily cap per tenant (admins edit it in Settings; today's row takes the new cap at once), reserved atomically before each live call:
  ```sql
  UPDATE llm_budget_days SET reserved_usd = reserved_usd + $worst_case
  WHERE spent_usd + reserved_usd + $worst_case <= cap_usd RETURNING …
  ```
  The worst case is estimated input tokens plus `max_tokens` at the output price. After the call, the reservation settles to the actual cost. Concurrent workers can't overshoot the cap. A worker that crashes holds its reservation until the day rolls over, which errs toward blocking rather than overspending. Replay calls don't touch the budget.
- **Cost** = Σ(token class × price) / 1e6, computed at write time and stored with `price_id`. Seed prices: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per MTok (verify these when scaffolding).
- **Latency** is wall-clock around the call. Note that the first request with a new schema pays a one-time compile cost.

**Other providers (OpenAI-compatible).** A config may also use OpenAI, DeepSeek, OpenRouter or any OpenAI-compatible server (`compat`), through the official `openai` SDK with a `baseURL`. The gateway, attempts, budget, cassettes and Ajv checks are shared; only the adapter in `packages/llm/src/providers/` differs.
- `response_format` is a strict `json_schema` (the same `toApiSchema()` output, which already lists every key as required and closes every object). JSON-mode-only models (DeepSeek) get `json_object` with the schema in the system prompt, and Ajv decides.
- PDFs go as `file` parts and images as `image_url` data URLs. A model that can't read PDFs gets a text-layer PDF as per-page text; a scan or image it can't read fails the run as `unsupported_file`.
- The response is normalized: `finish_reason` `stop`/`length`/`content_filter` (or `message.refusal`) map to `end_turn`/`max_tokens`/`refusal`, and the cached part of `prompt_tokens` is priced as a cache read. There is no server-side fallback.
- Models and their capabilities are a closed catalog in `packages/core`, each with a seeded price, so budget reservation works the same for every provider. Keys come from the deployment environment.

---

## 6. Score, gates, routing

- **Gates (any failure → review, with the reason recorded):**
  - Ajv validation fails.
  - A required field is null, or is listed in `uncertain_fields`.
  - **Evidence check:** `text` means the quote must appear in the source (normalized), with offsets stored for highlighting. `pdf_text` means it must appear on the cited page. `unverifiable` means the item always goes to review.
  - A built-in category rule fails (for example, invoice line items must sum to the total).
  - The category is `other`.
  - **Injection suspected:** the text addresses the triage system (a short, documented set of patterns in `pipeline/untrusted.ts`, such as "ignore … instructions" or a forged `<part>` tag). Part delimiters inside document text are also escaped before sending.
  - **Sender unauthenticated** (when the config's `policy.sender.require` is on): no DMARC (or DKIM) pass in an Authentication-Results header from a receiving server the config trusts.
    - **Mail synced from Gmail** (`StoredEmail.receivedBy`) is checked by default (`policy.sender.mailbox.require`, default true), against only the results Google wrote. Those are found by position (`providerAuthResults`): ARC results above Google's inbound `Received … by mx.google.com` hop, and the Authentication-Results just below it. Anything further down came with the message.
- **Score = the classification's `self_confidence`.** It is the only number compared against a threshold. Extraction quality is handled by the gates, not by multiplying scores together.
- **Decision:** auto only if every gate passes, `score ≥ threshold[category]`, and the category's `automation` is `auto_when_confident`, and the run wasn't triggered by a reclassify. The default is `review_all`, so automation is opt-in per category.
- **A correct auto-approval (one definition, used everywhere):** the right category **and** every required field correct under its comparator. Category accuracy alone never counts as a correct approval.
- **Audit:** an auto decision is held for review with kind `audit` at the category's `audit_rate` (default 10%). Audited outcomes give an unbiased production estimate of auto-approval precision. An audited item counts as correct only if the reviewer approved it without reclassifying and without editing a required field.
- **Limits, stated plainly in the README:** evidence matching proves a quote exists, not that it supports the value. The injection fixture is a regression test, not proof of injection resistance. Triage calls have no tools, the only action is a webhook to a tenant-configured target, and automation is opt-in, so the blast radius of a confidently wrong classification stays small.

---

## 7. Review queue UI

- **Claim next:** `FOR UPDATE SKIP LOCKED` over pending tasks and expired leases, returning a new `claim_token`. Opening a task claims it (or shows it read-only while someone else's lease lives). The lease is 10 minutes; the page renews it every minute while the tab is visible, so a hidden tab's claim lapses. An expired lease counts as no claim everywhere, so nothing needs to reap it. Lease time comes from `AppDeps.now`, which tests pin.
- **Inbox:** filters for kind, reason, category and age, with counts. Separate views for "Delivery failures" and "Processing failed". Polls every 5 s.
- **Detail view:** the source is on the left (email HTML, sanitized by the API and shown in a sandboxed iframe with a CSP that blocks remote loads; PDFs in the browser's own viewer with `#page=` jumps; plus a text view with evidence highlighted). On the right is a form rendered from the schema version, with gate failures marked on the affected fields (jsonb doesn't keep key order, so the detail API rebuilds a built-in category's schema from its template for the form's field order). Actions are **Approve**, **Edit & approve**, **Reclassify**, **Reject** and **Retry**, with keyboard shortcuts.
- Every decision writes an insert-only `review_decisions` row, which is the audit trail. An **"Add to eval set"** toggle (on for edits) creates an eval item from a copy of the source, in the split the user picks, defaulting to dev (phase 4).

---

## 8. Evals

- **Datasets** have dev, calib and test splits. Items can be imported from JSONL, or promoted from reviews ("Add to eval set"). The demo seed ships a labeled set.
- **Workflow the UI enforces:**
  1. Iterate prompts, models and effort on **dev**.
  2. Run the candidate config on **calib**, open the per-category **threshold sweep** (threshold vs auto rate vs precision, each with n and a Wilson lower bound) and the **reliability table** (score bucket vs accuracy and n), pick thresholds, then **Freeze** to create an immutable config version.
  3. Runs on **test** are allowed only for frozen configs, and those results are the headline numbers.
- **Runs** are realtime and concurrency-limited, so latency reflects production. The API inserts the run and one `eval.item` job per active item of the split in one transaction. Each item runs the pipeline's own parse, request builders, output parsing and `evaluateExtraction()` over its snapshot (no audit sampling), is graded, and commits its result and canonical attempts in one transaction; the last item finishes the run. Because items store their source exactly as documents do, eval requests are byte-identical to production's and replay from the same cassettes. A worker whose LLM mode differs from the run's fails the run rather than spending (or replaying) unexpectedly. They call the same `packages/core`, but the eval runner is **built without the actions store or the delivery queue**, so no code path reaches a webhook. And because `actions` requires a `documents` row, the database would refuse one anyway. Results persist only to `eval_results`.
- **Runner guards:**
  - The runner gets `EvalDeps` (`pool`, `storage`, `llm`, `limits`, `llmMode`, `now`), with no boss, actions or delivery. A type test pins those keys, and a source scan rejects `createAction`, `enqueue` and delivery imports under `apps/worker/src/evals/`.
  - Each item commits its result under a `FOR NO KEY UPDATE` lock on the run, and marks its attempts canonical only if the result was stored.
- **Eval items mirror documents:**
  - `source_key` / `source_mime` / `source_title` are stored exactly as ingestion stores a document's source: `EMAIL_SOURCE_MIME` for emails, one object per attachment, and the file name verbatim (it goes on the wire as a PDF title). Both paths parse through `parseSource`.
  - Schemas come from `category_schema_versions`, never from templates, because jsonb key order feeds the extract prompt.
  - Parse replaces lone surrogates, and `parseClassifyOutput` rounds the score to 3 decimals, as the database round trip does.
- **Freeze and activation:**
  - `createEvalRun` refuses a test run on an unfrozen config (`config_not_frozen`), and the `eval_runs_test_split` trigger backs it up.
  - Freeze creates a child version with `createCandidateConfig` + `freezeConfig`. It never uses `buildPipelineConfig`, which activates.
  - Activation requires a frozen config **when any category auto-approves** (phase 7). A version that sends every category to a person can't approve anything wrong, so it activates unfrozen. That's how Settings → Pipeline (and `tenant:create`, and custom categories) change models or categories without an eval set. Any change to a model, effort, prompt or category yields a version with every category on `review_all`, because classify sees every category's description; Freeze's routing-only changes don't.
  - Freeze turns on automation for a category only with at least `MIN_CALIB_ITEMS` (3) calib items of it and at least one required field. Otherwise "correct" would mean the category alone (§6).
- **Seeds:** `pnpm db:seed` ends with `seed:evals`, which builds the Main dataset from the fixtures and runs dev, calib and test (plus a DeepSeek candidate when its cassettes are recorded). `pnpm eval:import` adds labeled files from JSONL.
- **Metrics** (grades are stored on each result when it's written, so old runs keep the grades they were given):
  - Classification: accuracy, per-category precision, recall and F1, and a confusion matrix.
  - Extraction: per-field accuracy using typed comparators (exact, normalized string, parsed date, amount within 0.01, set F1 over the keys the label states, and presence only for free text written in the model's own words), over items whose category was predicted right, and a fully-correct-document rate over all items. A missing label key means the right answer is null.
  - Errors count as wrong and as review. An item labeled `other` is right when predicted `other`, and never auto-approves.
  - Routing: review rate and auto-approve precision (with the end-to-end definition from §6), per category, always with **n and a 95% Wilson lower bound**.
  - Cost per request (mean, p50, p95, by stage, cache hit ratio) and latency p50/p95 per stage.
  - **Run A vs run B** diff with a list of per-item regressions.
- **Production tab:** cost and latency by category and day, review rate, correction rate, and **audited auto-approval precision per category** (with n and the Wilson bound). The overall figure weights each audited item by 1 / audit_rate, so categories sampled at different rates combine correctly.
- **Threshold sweep:** per category, over items that nothing but the threshold or the automation setting held back, each distinct score as a candidate threshold, with the auto rate (over items predicted as the category) and precision, each with n and the bound. Freeze takes the chosen threshold, automation and audit rate per category into a new frozen child of the calib run's config (same models, prompts, schemas and policy).
- **Replay labeling:** every run or chart built from replayed calls carries a "Replay" badge. Tokens and cost display as *recorded* (from the cassette), latency displays as *recorded live latency*, and "Actual spend" counts only `mode = live` rows.

---

## 9. Build phases

0. **Setup:** pick a project folder (folder picker) and `git init`, then the monorepo, docker-compose with the one-shot `init` service and Dockerfile (both landed with phase 4), lint, typecheck, vitest, a GitHub Actions CI on replay mode, and the MIT LICENSE.
1. **Foundation:** Drizzle schema, the RLS and composite-FK migration, `withTenantTx` with the pg-boss adapter, Better Auth with orgs, immutable configs, the price seed and the demo seed skeleton.
2. **Pipeline:** the upload flow, Postmark webhook, REST and `pnpm ingest`; parse (email, DOCX, PDF text detection), classify, extract, evidence check, gates and route; the `llm` wrapper with response reuse and the record/replay cassettes; three built-in categories (`invoice`, `support_request`, `contract`) plus `other`; and the fixtures.
3. **Review (done):** the inbox, detail view, claim token, approve/edit/reclassify/reject/retry, extraction revisions, audit sampling, the actions outbox, signed delivery, the failures views, and a local webhook catcher.
4. **Evals (done):** datasets and splits, the review UI's "Add to eval set", realtime runs, metrics, the threshold sweep with reliability table and Freeze, test-split gating, run diff, the production tab with replay labeling, and the README: screenshots plus the **demo walkthrough** (§10) as a short GIF.

5. **Security (done):** the threat model and controls are in [security.md](security.md). Milestones:
   - M0: a lean AGENTS.md and the security docs.
   - M1: HTTP edge (headers, CSP, Origin checks, body limits, safe startup config).
   - M2: an audit log.
   - M3: outbound webhooks (SSRF guard, encrypted secrets, rotation grace, signature v2).
   - M4: rate limits and an editable budget.
   - M5: untrusted content (served file types, upload and email limits, parser limits, injection and sender-authentication gates).
   - M6: TOTP 2FA, sessions and API key management.
   - M7: deletion and retention.
   - M8: supply chain, CI and container.
6. **Google Workspace (done):** Google setup is in [google.md](google.md). Milestones:
   - M0: closed sets, env and docs.
   - M1: Sign in with Google (no TOTP bypass, admission gate).
   - M2: `pnpm tenant:create`, members and invitation links.
   - M3: the Google OAuth module and mailbox connections.
   - M4: the Gmail sync worker.
   - M5: Workspace domain auto-join.
   - M6: sender authentication for synced mail, source display, eval parity.
   - M7: a fake Google for the demo and e2e, and the security docs.
7. **Production-ready (in progress):** reliability under real mail volume, a fast path from clone to a real deployment, and tenant-defined categories. Milestones:
   - M0: docs and closed sets.
   - M1: a config registry, `pnpm preflight` and one-command dev setup.
   - M2: a single origin, with the API under `/api`, and one `PUBLIC_URL`.
   - M3: slim prebuilt images on GHCR, releases and a CHANGELOG.
   - M4: timeouts, pools, graceful shutdown and sandboxed parsing.
   - M5: per-tenant fairness (pg-boss groups) and provider backpressure.
   - M6: self-healing (a reconciler for stalled work) and Retry all.
   - M7: observability: JSON logs, metrics, health, worker heartbeats, a System health page.
   - M8: a simulated model, a mail variety generator, load and chaos tests.
   - M9: intake filters for auto-replies, bounces and bulk mail.
   - M10: a first-run setup page, a getting-started checklist and UI polish.
   - M11: pipeline settings (activating `review_all` configs without freezing).
   - M12: custom categories.
   - M13: the public API's reads, key scopes and OpenAPI.
   - M14: production deploy on one VM (Compose and Caddy).
   - M15: docs, e2e in CI and release 0.7.0.

**Later:** a DB- or admin-managed model catalog with per-tenant provider keys, a Batch API eval mode (50% cost), OCR for scans, a custom category schema editor, Microsoft 365 / Outlook sync, Gmail push (Pub/Sub) and Workspace domain-wide delegation, outbound invitation email, erasing eval items, SSE, OpenTelemetry, and dual-run agreement.

---

## 10. Verification

- **Unit (vitest):**
  - Gates and reasons, the evidence check for each mode, `toApiSchema()`, the comparators, the Wilson bound and the cost formula.
  - Route returns a proposed action without touching the database.
- **Correctness tests:**
  - **Crash after the attempt is saved:** the retry reuses it and makes no second call.
  - **Crash before the attempt is saved** (fault injected right after Claude returns): the retry makes a second call, but the result is still exactly one canonical attempt, one extraction and at most one action.
  - Reclassify clears the claim. Approving during `awaiting_extraction` returns 409, and the replacement extraction goes to review even when its score clears the threshold.
  - Each task kind rejects actions outside its list (for example, Approve on `processing_failed`).
  - Replay with a missing cassette fails with `CassetteMissError` and makes no network call.
  - Twenty concurrent budget reservations against a cap that fits five: exactly five succeed.
  - An `llm_calls` insert with zero or two execution contexts fails the CHECK.
  - A stale `claim_token` or an outdated `extraction_id` returns 409.
  - A cross-tenant FK insert fails, and RLS hides tenant B's rows even when the query omits `WHERE tenant_id`.
  - `uploads/:id/complete` rejects another tenant's upload.
  - An eval run creates **zero** `actions` rows, and the eval runner's dependency wiring has no action or delivery port.
  - A redelivered webhook carries the same `Idempotency-Key`.
  - Test-split runs are refused for unfrozen configs.
- **End to end (replay mode in CI, live mode locally):** ingest the fixtures and assert that the clear cases auto-approve (on categories with automation enabled), the ambiguous ones and the scans land in review with the right reasons, the injection fixture doesn't auto-approve, and a duplicate webhook does nothing.
- **UI (built-in browser):** claim, edit and approve an item and see the signed webhook arrive at the catcher. Reject an item and confirm it stays terminal. Promote it to the dataset, run dev, then calib, freeze, then run test, and check that the metrics show their n and bounds and that the run's cost equals the sum of its `llm_calls`.
- **Demo walkthrough** (a scripted Playwright e2e in replay mode, and the README GIF): ingest an invoice, show its evidence highlights and routing reasons, correct a field, and approve that exact revision. Then show that a second tab still holding the old revision gets a 409, and that a forced redelivery reaches the catcher with the same `Idempotency-Key` while `actions` still has one row.
- **Google (phase 6):** against `FakeGoogle` (`@ai-triage/mailbox/testing`) and a stubbed Google token endpoint, covering:
  - Admission (no user without an invitation or a claimed domain), linking only verified emails, and TOTP after Google.
  - Invitation links (single use, expiry, revoke, email match), the last-admin guard, and a removed member's next request being refused.
  - OAuth state (single use, same user, same tenant, ten minutes), a refused grant without Gmail access, and encrypted tokens.
  - Sync: one document per message, an expired cursor without gaps, CAS, a dead grant stopping the poll, deferral over the limit, and purge tombstones.
  - Forged authentication results below Google's trace being ignored, and eval snapshots keeping `receivedBy`.
  - The `e2e/gmail.spec.ts` walkthrough against `pnpm fake-google`.
- `pnpm typecheck && pnpm lint && pnpm test` all pass.
