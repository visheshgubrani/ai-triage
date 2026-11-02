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
                        │                                 │
                  RustFS/S3 (server-issued keys)          │
                        ^                                 │
 pg-boss ──> worker: parse → classify → extract → route ──┼─> auto (+not sampled) ─> actions outbox ─> signed webhook
                         │ LLM response saved immediately └─> review / audit ─> human ─> actions outbox
                         v
                   Claude API      (eval runner: same core, results → eval_results only)
```

Three processes from one image (`web`, `api`, `worker`), plus Postgres and RustFS in docker-compose.

**Why pg-boss over QStash:** jobs are enqueued in the same transaction as the data that triggers them, and only when the transaction's client is passed to `boss.send(…, { db })`; sharing a database isn't enough on its own. It also means no public worker endpoints, no HTTP timeouts on slow LLM or PDF work, built-in retries, cron and dead-lettering, and stuck jobs you can find with SQL. The queue sits behind a small `Queue` interface.

---

## 2. Repo layout (pnpm + Turborepo, MIT license)

```
apps/web        Next.js App Router (UI only)
apps/api        Hono on Node: UI REST, public API (tenant API keys), Postmark webhook, upload flow
apps/worker     pg-boss handlers + cron (lease reaper, delivery retries)
packages/db         Drizzle schema, RLS + composite-FK migrations, withTenantTx(), seeds
packages/core       pure pipeline: parse, classify, extract, verifyEvidence, gates, route → {decision, proposedAction}
packages/llm        Claude wrapper: call → llm_calls (tokens, cost, latency); live | record | replay modes
packages/schemas    category templates (Zod) → JSON Schema; toApiSchema(); Ajv validators
packages/evals      comparators, metrics, Wilson interval, threshold sweep, run diff
packages/contracts  Zod API types shared by api + web
fixtures/           synthetic emails/PDFs/scans per category (+ ambiguous, injection); LLM cassettes
infra/              docker-compose (postgres, rustfs, webhook-catcher), Dockerfile
```

**OSS ergonomics:**
- **The quickstart is `docker compose up --build`.** A one-shot `init` service runs migrations, creates the storage bucket and seeds the demo tenant (around 60 synthetic documents and a labeled dataset with splits), and it is idempotent. `api`, `worker` and `web` wait for it with `depends_on: condition: service_completed_successfully`. The demo runs in **replay mode**, so the evals page is populated and no API key is needed.
- **`LLM_MODE` is explicit.** `replay` (the default) serves cassettes from `fixtures/cassettes`, keyed by request hash. **A missing cassette is a hard error** (`CassetteMissError`, naming the hash and the record command), never a silent fallback to a paid call. `record` calls the live API and writes cassettes. `live` has to be set on purpose.
- The contributor dev loop is `docker compose up -d postgres storage` followed by `pnpm dev`. `pnpm ingest <file>` pushes an .eml, PDF or JSON file through the real ingestion path.
- The README carries the architecture diagram, an evals screenshot, a "design decisions" section and a "known limits" section (repeat model calls, what evidence matching proves, injection).

---

## 3. Tenant isolation

- `tenant_id` on every tenant table, plus **RLS** (`tenant_id = current_setting('app.tenant_id')::uuid`) with the app connecting as a non-owner role.
- **Composite FKs:** parent tables declare `unique (tenant_id, id)`, and children reference `(tenant_id, document_id) → documents(tenant_id, id)`. A cross-tenant reference fails at the database even if the code has a bug.
- `withTenantTx(tenantId, fn)` takes one `pg` PoolClient, runs `BEGIN; SET LOCAL app.tenant_id`, and gives `fn` both a Drizzle handle and a pg-boss `db` adapter (`executeSql` on the same client). Workers take the tenant from the job payload. A `BYPASSRLS` role is used only for cron maintenance.
- **Storage:** the client never supplies a key. `POST /uploads` creates an `uploads` row with a server key (`t/{tenant}/u/{uuid}`), an expiry and a presigned PUT. `POST /uploads/:id/complete` checks the row belongs to the tenant, HEADs the object to confirm size and mime, then creates the document. Downloads go through `GET /documents/:id/source`: the RLS-checked lookup returns a short-lived presigned GET.
- Review decisions and actions resolve every referenced id inside the tenant transaction. Webhook targets come only from tenant settings.
- **Short transactions:** read under the tenant context and commit, call Claude with no transaction open, then commit the result with revision checks.
- Auth: Better Auth with the organizations plugin. Roles are `admin`, `reviewer` and `viewer`.

---

## 4. Data model (key tables)

| Table | Notes |
|---|---|
| `tenants`, `users`, `memberships`, `api_keys` | — |
| `inbound_addresses` | `address` unique → tenant |
| `uploads` | server-issued `storage_key`, expected size/mime, `expires_at`, `completed_at` |
| `documents` | `source`, `external_id` (Message-ID header, else Postmark MessageID, else content hash), unique `(tenant_id, source, external_id)`, `source_key`, **`processing_status`**, **`review_status`**, **`delivery_status`**, `current_run_id`, `current_extraction_id` |
| `document_parts` | text with offsets, or per-page PDF text, plus `evidence_mode` (`text`/`pdf_text`/`unverifiable`) |
| `pipeline_configs` | **immutable versions**: model + effort per stage, prompt version ids, category schema version ids, policy, thresholds, `automation` per category, audit rate. The tenant points at one active config; `frozen_at` is set once it has been validated |
| `category_schema_versions`, `prompt_versions` | immutable |
| `processing_runs` | document, `config_id`, trigger (`ingest`/`retry`/`reclassify`), `forced_category`, status, `superseded_by` |
| `llm_calls` | **one row per attempt**. Execution context is **either** `processing_run_id` **or** `eval_run_id` + `eval_item_id`, with a CHECK that exactly one is set. stage, attempt, **`canonical`** (partial unique index: one canonical success per context and stage), **`mode` (`live`/`replay`)**, model, effort, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd`, `price_id`, `latency_ms`, `stop_reason`, `served_by_fallback`, `request_id`, **`response` jsonb**, error |
| `classifications` | run, category, `self_confidence`, rationale |
| `extractions` | **revisions**: document, run (null if a human wrote it), `revision`, `author` (`model`/`user`), `parent_id`, `fields`, `validation_errors`, `gate_results`, `score`, `decision`, `decision_reasons[]`; unique `(document_id, revision)` |
| `review_tasks` | document, `kind` (`review`/`audit`/`processing_failed`/`unclassified`), `extraction_id` (**nullable**; a CHECK requires it when kind is `review` or `audit`), reasons, status (`pending`/`claimed`/`awaiting_extraction`/`resolved`), `claimed_by`, **`claim_token`**, `lease_expires_at` |
| `review_decisions` | reviewer, outcome, `before`, `after`, diff, note |
| `actions` | document, **`extraction_id`**, **frozen `payload`**, `idempotency_key` (= action id), status, attempts, `last_error` |
| `model_prices` | per-MTok input/output/cache-write/cache-read, batch multiplier, `effective_from` |
| `llm_budget_days` | `(tenant_id, day)` → `cap_usd`, `spent_usd`, `reserved_usd` |
| `eval_datasets`, `eval_items` | immutable source snapshot key, `expected_category`, `expected_fields`, **`split` (`dev`/`calib`/`test`)**, origin, tags. No link to `documents` |
| `eval_runs`, `eval_results` | run: `config_id`, split, `llm_mode`, status, aggregates. Result: predicted category and fields, field scores, decision, **`proposed_action`** (stored, never sent), cost, latency, canonical llm_call ids |

---

## 5. Pipeline and state transitions

**Ingestion (API).**
- **Postmark:** basic auth credentials in the HTTPS webhook URL (optionally an IP allowlist). The parsed JSON payload is stored as `source.json`, and attachments are decoded into separate objects.
- **Uploads:** the two-step flow in §3.
- **REST/CLI:** the same path, authenticated with a tenant API key.
- In every case, inserting the document, creating `processing_run` #1 and enqueueing `doc.parse` happen in one transaction. A duplicate `external_id` returns 200 and does nothing.

**Each stage handler (parse → classify → extract → route) follows the same three steps:**
1. **Read.** In a short transaction, load the run and its inputs. Stop if the run is superseded or the stage is already done.
2. **Call.** If a successful attempt already exists for `(context, stage)`, reuse it. Otherwise reserve budget (live mode only; see below), call Claude, and **insert the attempt row, response included, in its own small transaction right away**. This narrows repeat calls but can't remove them: if the worker crashes between Claude returning and that insert, the retry calls Claude again. The README says so plainly: *repeated model calls are possible, and saved responses are reused whenever available.* Every attempt is kept for cost accounting.
3. **Commit.** In one transaction: mark the attempt used as `canonical`, write the stage result and advance status with `WHERE current_run_id = $run AND processing_status = $expected`, then enqueue the next job through the same client. If the guard matches nothing, the run is stale and the handler exits. Stage results are unique per run and stage, and actions are unique per approved revision, so a repeated model call can never produce a second extraction or a second action.

**Parse.**
- Email bodies become plain text with offsets. DOCX goes through `mammoth`.
- PDFs go through `unpdf` to get per-page text. If the text layer is substantial, `evidence_mode = pdf_text`; otherwise it's a scan and `evidence_mode = unverifiable`. Images are always `unverifiable`.
- The PDF or image itself is still sent to Claude as a document or image block, so the model sees the layout.
- App limits: `MAX_FILE_MB=32`, `MAX_PDF_PAGES=100` (configurable, and below the API's own limits).

**Classify** returns `{ category: enum(tenant categories + "other"), self_confidence: 0..1, rationale }`.

**Extract** returns, for each field, `{ value, evidence: { quote, page? } | null }`, plus `uncertain_fields: string[]`. The schema comes from `toApiSchema()`.

**Route** is pure: gates, then score, then a decision and a proposed action (§6). Production persists the decision. If the result is auto and the item isn't picked for audit, it creates the `actions` row and enqueues `action.deliver` in the same transaction. Otherwise it creates a `review_tasks` row.

**Exceptional transitions:**
| Situation | Result |
|---|---|
| Parse or LLM fails after retries (or a 400 or refusal) | `processing_status=failed`, review task `processing_failed`. The reviewer can **Retry** (new run) or **Reject** |
| Category is `other` | Extraction is skipped and `processing_status=done`. A review task of kind `unclassified` lets the reviewer **Reclassify** or **Reject** |
| Reviewer reclassifies (only while review is pending) | In one transaction: a new run with `forced_category` starts at extract, the old run is marked superseded, and the task moves to `awaiting_extraction` with its claim cleared, so it can't be approved. When the new extraction lands, the task goes back to `pending` as kind `review` and **always to a human**: runs triggered by a reclassify skip auto-routing |
| Reviewer edits | A new extraction revision with `author=user` |
| Approve | `review_status=approved`, plus an action with a frozen payload for that exact revision |
| Reject | `review_status=rejected`, which is terminal. No action is created and `delivery_status` stays `none` |
| Delivery exhausts its retries | `delivery_status=failed`. The item shows in a "Delivery failures" filter with manual **Redeliver** (same idempotency key). The review outcome doesn't change |

**Actions by task kind** (enforced by the API, not only the UI):
| Task kind | Available actions |
|---|---|
| `processing_failed` | Retry, Reject |
| `unclassified` | Reclassify, Reject |
| `review`, `audit` | Approve, Edit & approve, Reclassify, Reject |

**Approval check (one transaction):** the task must be claimed by this user, `claim_token` must match, the lease must be valid, and `extraction_id` must equal `documents.current_extraction_id`. Any mismatch returns 409 and the UI reloads. An expired browser tab can't approve.

**Delivery:** HMAC-signed POST with the `Idempotency-Key` and `X-Triage-Signature` headers, at least once, with retries handled by pg-boss. A dead-letter handler marks the action failed. The README documents the receiver contract.

**Claude calls (`@anthropic-ai/sdk`):**
- `messages.create` with `output_config.format` json_schema, sent the stripped schema. Ajv then validates the **full** schema.
- Model and effort come from the config. The default is `claude-opus-5-5` at `effort: "low"` for classify and `"low"`/`"medium"` for extract, and the evals page compares alternatives such as `claude-sonnet-5-5` and `claude-haiku-5-5`.
- `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), with a `stop_reason` check before reading content.
- The system prompt (instructions, category definitions, few-shot examples) is cached; the document comes after it.
- **Budget:** a daily cap per tenant, reserved atomically before each live call:
  ```sql
  UPDATE llm_budget_days SET reserved_usd = reserved_usd + $worst_case
  WHERE spent_usd + reserved_usd + $worst_case <= cap_usd RETURNING …
  ```
  The worst case is estimated input tokens plus `max_tokens` at the output price. After the call, the reservation settles to the actual cost. Concurrent workers can't overshoot the cap. A worker that crashes holds its reservation until the day rolls over, which errs toward blocking rather than overspending. Replay calls don't touch the budget.
- **Cost** = Σ(token class × price) / 1e6, computed at write time and stored with `price_id`. Seed prices: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per MTok (verify these when scaffolding).
- **Latency** is wall-clock around the call. Note that the first request with a new schema pays a one-time compile cost.

---

## 6. Score, gates, routing

- **Gates (any failure → review, with the reason recorded):**
  - Ajv validation fails.
  - A required field is null, or is listed in `uncertain_fields`.
  - **Evidence check:** `text` means the quote must appear in the source (normalized), with offsets stored for highlighting. `pdf_text` means it must appear on the cited page. `unverifiable` means the item always goes to review.
  - A built-in category rule fails (for example, invoice line items must sum to the total).
  - The category is `other`.
- **Score = the classification's `self_confidence`.** It is the only number compared against a threshold. Extraction quality is handled by the gates, not by multiplying scores together.
- **Decision:** auto only if every gate passes, `score ≥ threshold[category]`, and the category's `automation` is `auto_when_confident`, and the run wasn't triggered by a reclassify. The default is `review_all`, so automation is opt-in per category.
- **A correct auto-approval (one definition, used everywhere):** the right category **and** every required field correct under its comparator. Category accuracy alone never counts as a correct approval.
- **Audit:** an auto decision is held for review with kind `audit` at the category's `audit_rate` (default 10%). Audited outcomes give an unbiased production estimate of auto-approval precision. An audited item counts as correct only if the reviewer approved it without reclassifying and without editing a required field.
- **Limits, stated plainly in the README:** evidence matching proves a quote exists, not that it supports the value. The injection fixture is a regression test, not proof of injection resistance. Triage calls have no tools, the only action is a webhook to a tenant-configured target, and automation is opt-in, so the blast radius of a confidently wrong classification stays small.

---

## 7. Review queue UI

- **Claim next:** `FOR UPDATE SKIP LOCKED` over pending tasks and expired leases, returning a new `claim_token`. The lease is 10 minutes and is extended on activity.
- **Inbox:** filters for kind, reason, category and age, with counts. Separate views for "Delivery failures" and "Processing failed". Polls every 5 s.
- **Detail view:** the source is on the left (sanitized email HTML in a sandboxed iframe, or pdf.js with a page jump plus a text view with evidence highlighted). On the right is a form rendered from the schema version, with gate failures marked on the affected fields. Actions are **Approve**, **Edit & approve**, **Reclassify**, **Reject** and **Retry**, with keyboard shortcuts.
- Every decision writes `review_decisions` and an audit entry. An **"Add to eval set"** toggle (on for edits) creates an eval item from a copy of the source, in the split the user picks, defaulting to dev.

---

## 8. Evals

- **Datasets** have dev, calib and test splits. Items can be imported from JSONL, promoted from reviews, or labeled in the review UI's label mode. The demo seed ships a labeled set.
- **Workflow the UI enforces:**
  1. Iterate prompts, models and effort on **dev**.
  2. Run the candidate config on **calib**, open the per-category **threshold sweep** (threshold vs auto rate vs precision, each with n and a Wilson lower bound) and the **reliability table** (score bucket vs accuracy and n), pick thresholds, then **Freeze** to create an immutable config version.
  3. Runs on **test** are allowed only for frozen configs, and those results are the headline numbers.
- **Runs** are realtime and concurrency-limited, so latency reflects production. They call the same `packages/core`, but the eval runner is **built without the actions store or the delivery queue**, so no code path reaches a webhook. And because `actions` requires a `documents` row, the database would refuse one anyway. Results persist only to `eval_results`.
- **Metrics:**
  - Classification: accuracy, per-category precision, recall and F1, and a confusion matrix.
  - Extraction: per-field accuracy using typed comparators (exact, normalized string, parsed date, amount tolerance, set F1) and a fully-correct-document rate.
  - Routing: review rate and auto-approve precision (with the end-to-end definition from §6), per category, always with **n and a 95% Wilson lower bound**.
  - Cost per request (mean, p50, p95, by stage, cache hit ratio) and latency p50/p95 per stage.
  - **Run A vs run B** diff with a list of per-item regressions.
- **Production tab:** cost and latency by category and day, review rate, correction rate, and **audited auto-approval precision per category** (with n and the Wilson bound). The overall figure weights each audited item by 1 / audit_rate, so categories sampled at different rates combine correctly.
- **Replay labeling:** every run or chart built from replayed calls carries a "Replay" badge. Tokens and cost display as *recorded* (from the cassette), latency displays as *recorded live latency*, and "Actual spend" counts only `mode = live` rows.

---

## 9. Build phases

0. **Setup:** pick a project folder (folder picker) and `git init`, then the monorepo, docker-compose with the one-shot `init` service, Dockerfile, lint, typecheck, vitest, a GitHub Actions CI on replay mode, and the MIT LICENSE.
1. **Foundation:** Drizzle schema, the RLS and composite-FK migration, `withTenantTx` with the pg-boss adapter, Better Auth with orgs, immutable configs, the price seed and the demo seed skeleton.
2. **Pipeline:** the upload flow, Postmark webhook, REST and `pnpm ingest`; parse (email, DOCX, PDF text detection), classify, extract, evidence check, gates and route; the `llm` wrapper with response reuse and the record/replay cassettes; three built-in categories (`invoice`, `support_request`, `contract`) plus `other`; and the fixtures.
3. **Review:** the inbox, detail view, claim token, approve/edit/reclassify/reject/retry, extraction revisions, audit sampling, the actions outbox, signed delivery, and the failures views.
4. **Evals:** datasets and splits, realtime runs, metrics, the threshold sweep with reliability table and Freeze, test-split gating, run diff, the production tab with replay labeling, and the README: screenshots plus the **demo walkthrough** (§10) as a short GIF.

**Later:** a Batch API eval mode (50% cost), OCR for scans, a custom category schema editor, Gmail/Outlook sync, per-tenant fairness and budgets, a retention purge, SSE, OpenTelemetry, and dual-run agreement.

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
- `pnpm typecheck && pnpm lint && pnpm test` all pass.
