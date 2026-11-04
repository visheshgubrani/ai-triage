# AGENTS.md

Context for coding agents (and humans). Keep it lean: only what every session needs. The details live in:
- [docs/architecture.md](docs/architecture.md): the agreed design and the source of truth.
- [docs/guide.md](docs/guide.md): using the app (review, evals, categories, Gmail, API) and the known limits.
- [docs/llm.md](docs/llm.md): model providers, Claude API notes, LLM modes and cassettes.
- [docs/security.md](docs/security.md): the threat model, controls and the production checklist.
- [docs/google.md](docs/google.md): the Google OAuth client, Gmail sync and what Google requires.
- [docs/install.md](docs/install.md): installing and running it (install.sh, deploy/, ./triage), including how an AI agent should install it.
- [docs/api.md](docs/api.md): the public REST API (scopes, states) and the webhook receiver contract.
- [docs/operations.md](docs/operations.md): health checks, logs, metrics, alerts and runbooks. [docs/configuration.md](docs/configuration.md) (generated) lists every variable; [docs/troubleshooting.md](docs/troubleshooting.md) is by symptom.

**ai-triage** is an open-source, multi-tenant AI triage inbox:
1. Emails (Postmark inbound, Gmail mailbox sync) and documents (uploads, REST API) come in.
2. An LLM classifies each one and extracts fields against a versioned JSON Schema (Ajv).
3. Deterministic gates plus a per-category threshold route it to auto-approve (opt-in per category) or a human review queue.
4. Approvals fire a signed webhook through an outbox.
5. An evals page runs the same pipeline over a labeled dataset (dev/calib/test).

It's an MVP and a portfolio project: correct where correctness is cheap, runnable by a stranger with no API key, and readable.

**Status:** phases 1–6 (foundation, pipeline, review, evals, security, Google Workspace) are done. Phase 7 (production-ready: reliability, getting started, custom categories) is in progress (architecture §9).

## Repo map

```
apps/api        Hono API (UI REST, public API, webhooks). Exports ./client for web.
apps/worker     pg-boss handlers + cron (pipeline stages, delivery, eval runner)
apps/web        Next.js UI only (no business logic, no DB access)
packages/db         Drizzle schema + migrations. The ONLY package that imports drizzle-orm / pg.
packages/core       Closed sets (`.`, web-safe) and the pure pipeline (`./pipeline`, Node-only). No I/O.
packages/llm        Model gateway (Claude + OpenAI-compatible) + llm_calls + replay/record/live
packages/schemas    Built-in templates, custom category definitions + starters, prompts, toApiSchema(), Ajv, rules (a leaf)
packages/storage    S3 client, presigned URLs, server-issued storage keys
packages/ingest     Ingestion paths: store the source, then create document + run + parse job
packages/evals      Comparators, grading, metrics, threshold sweep, reliability, run diff (pure, web-safe)
packages/mailbox    Mail providers: Google config, OAuth and Gmail REST over an injected fetch (no SDK)
packages/webhooks   Outbound webhooks: the signer, the SSRF-guarded fetch and one signed POST (delivery and the test event)
packages/telemetry  JSON logger, trace ids (AsyncLocalStorage) and a Prometheus registry; no deps
packages/contracts  Zod API contracts shared by api and web
fixtures/           Synthetic labeled docs (generated, committed) + LLM cassettes
```

## Commands

```bash
pnpm install                 # Node >= 24, pnpm 12
pnpm dev:setup               # .env, infra:up, db:migrate, db:seed (idempotent); dev:reset wipes local data first
pnpm infra:up                # Postgres :5440, RustFS :9020 (console :9021), webhook catcher :9030
pnpm db:migrate              # app role, migrations, pg-boss + queues
pnpm db:seed                 # prices, demo tenant (admin@demo.test / reviewer@demo.test, demo-password), 60 docs, eval runs
pnpm preflight               # is this installation ready? each failed check prints its fix
pnpm config:docs             # after editing packages/core/src/env.ts: regenerates .env.example and docs/configuration.md
pnpm dev                     # api :8787, web :3000, worker
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # must all pass before you're done (pnpm test needs infra:up)
pnpm test:unit               # no Postgres needed
pnpm e2e                     # Playwright walkthroughs against a running `pnpm dev` (local only)
pnpm db:generate             # after editing packages/db/src/schema
pnpm format                  # Biome autofix
pnpm ingest <file>           # .pdf/.docx/.eml/.png/.txt via the REST API (TRIAGE_API_KEY), .json as a Postmark payload
pnpm api-key:create --tenant demo
pnpm tenant:create --name Acme --slug acme --admin you@acme.com   # a real tenant + the first admin's invite link
pnpm setup-link              # a fresh first-run setup link while no workspace exists (the api also logs one at startup)
pnpm fake-google             # a fake Google on :9040 for mailbox sync without a Google project (docs/google.md)
pnpm llm-sim                 # the simulator on :9050 for `sim:simulated` (LLM_SIMULATOR_URL=http://localhost:9050/v1), any LLM_MODE, $0
pnpm load --docs 1000 --tenants 5 --skew 0.8   # load and chaos test against a running stack (docs/reliability.md)
pnpm eval:import <items.jsonl> [--dataset Main]
pnpm demo:video              # the README's demo video, teaser GIF and screenshots, from a FRESH demo (CONTRIBUTING.md)
LLM_MODE=record pnpm cassettes:record --yes   # SPENDS MONEY (see docs/llm.md)
docker compose up            # the whole demo in containers (pulls the GHCR image; --build builds it), replay mode, no key
TRIAGE_SOURCE=$PWD TRIAGE_IMAGE=ai-triage ./install.sh --version dev --port 4200 --dir /tmp/t   # install from this checkout (docker build -t ai-triage:dev . first)
```

## Conventions

- **Workspace packages ship TypeScript source** (`"exports": "./src/index.ts"`, no build step).
  - api and worker bundle them **and their npm dependencies** with tsup (`apps/worker/tsup.shared.ts`), and Next uses `transpilePackages` with `output: "standalone"`. So the image holds no node_modules for the server processes.
  - Internal deps use `"workspace:*"`; add deps with `pnpm --filter <pkg> add <dep>`.
- **Only `packages/db` imports `drizzle-orm` or `pg`.** A second import site once installed a duplicate drizzle-orm and broke types. Expose helpers from `@ai-triage/db` instead.
- **Core subpaths.** `@ai-triage/core` is constants-only, so web can import it. Parsers and pipeline logic live in `@ai-triage/core/pipeline`.
- **API.** Contracts are Zod schemas in `packages/contracts`. Web calls the API only through the Hono RPC client.
  - One origin: every route is under `/api` (`createApp` mounts `apiRoutes`; `AppType` is the un-prefixed set). Caddy routes `/api/*` in containers, a Next rewrite in `pnpm dev`. `PUBLIC_URL` is the only public address (`resolvePublicUrls`).
  - Tests call `t.app.request("/me")` (the helper adds `/api`); `t.server.request` reaches real paths, such as the root `/health`, `/webhooks` and `/v1`.
- **UI.** shadcn/ui on Radix: primitives in `apps/web/src/components/ui` are generated (`pnpm dlx shadcn@4.23.0 add <name>`; left as generated, apart from `SidebarInset` being a div). App components (`Button`, `Section`, `DataTable`, `Badge`/`Pill`, `Notice`, `useConfirm`…) sit in `components/`. Colours come from the tokens in `globals.css`, never raw palette classes.
  - Theme is a cookie the root layout reads, with no script (the CSP refuses inline ones). Charts use the fixed `--chart-N` slots.
  - The e2e specs count on one `<main>` per page (the shell's), native `<select>`s, mailbox cards being `<section>`s, and no stray `role=alert`/`status`: so no toasts, and system banners sit outside `<main>`.
- **Env.** One root `.env`, loaded with `--env-file-if-exists=../../.env` or `process.loadEnvFile`. Every variable is declared in `packages/core/src/env.ts`; the api and worker check theirs at startup (`assertEnv`, then `checkStartup` for the database).
- **Style.** Biome (2 spaces, double quotes, 120 columns). Tests sit next to source as `*.test.ts`; `*.db.test.ts` need Postgres.
- **Database roles.**
  - `DATABASE_OWNER_URL` is only for migrations, seeds and drizzle-kit.
  - The app runs as `DATABASE_URL` (`triage_app`, in the NOLOGIN group `app_rw`), and `assertAppRole()` refuses a role that bypasses RLS.
- **Tenant data goes through `withTenantTx(pool, tenantId, fn)`;** outside it, RLS hides every tenant table. Lookups that happen before a tenant is known use SECURITY DEFINER resolvers (`0003_resolvers.sql`).
- **Enums are `text` + CHECK** built from core arrays (`oneOf()`), never `pgEnum`. The migrator runs pending files in one transaction, and a value added with `ALTER TYPE … ADD VALUE` can't be used in that transaction.
- **Migrations** are generated by drizzle-kit. Raw SQL (RLS, triggers, grants) goes in `drizzle-kit generate --custom --name=<name>` files. Never edit an applied migration.
- **pg-boss.** Runtime instances come from `createBoss()`, which doesn't migrate, because the app role can't do DDL. Enqueue inside the transaction with `enqueue(boss, tx, …)` (or `enqueueMany`); outside one, `sendTenantJob`. These put the job in its tenant's group (fairness); `boss.test.ts` refuses any other `boss.send`/`boss.insert`.
- **Better Auth tables** (`users`, `sessions`, `accounts`, `verifications`, `tenants`, `memberships`, `invitations`) are global, with no RLS, and keep BA's naming. Public sign-up is off: tenants come from `createTenant()` (`pnpm tenant:create`), users from invitations (`packages/db/src/members.ts`), Workspace domain auto-join, or `ensurePasswordUser()` (seeds, tests).
- **pnpm 12 blocks dependency build scripts.** Approve one with `pnpm approve-builds <pkg>`.

## Invariants (details in docs/architecture.md)

1. **Tenant isolation (§3):** every tenant table has `tenant_id`, RLS and composite FKs `(tenant_id, x_id) → parent(tenant_id, id)`; all access goes through `withTenantTx()`; storage keys are server-issued.
2. **Short transactions (§5):** read and commit, then call the model, then commit with revision checks. Never hold a transaction across a model call.
3. **Atomic stage commit (§5):** stage result, guarded status advance and next-job enqueue in one transaction (`boss.send(…, { db })`).
4. **LLM attempts (§5):** saved on arrival, reused on retry, exactly one `canonical` per context and stage; `llm_calls` has exactly one execution context.
5. **Approvals (§5)** bind to an exact `extraction_id` + `claim_token` with a frozen payload; actions follow `ACTIONS_BY_TASK_KIND` (API-enforced); reclassify always returns to a human.
6. **Webhooks (§5)** are delivered at least once with a stable `Idempotency-Key` (the action id).
7. **Evals can't act (§8):** the runner has no actions or delivery ports, and eval items never create `documents` rows.
8. **No surprise spend (docs/llm.md):** `LLM_MODE` defaults to `replay`, a missing cassette is a hard error, live is opt-in, budget is reserved atomically, replayed figures are labeled as recorded.
9. **Correct auto-approval (§6)** = right category **and** every required field correct. Thresholds come from `calib`, the config is frozen, then `test` runs; always show n and the Wilson bound. A version that auto-approves anything must be frozen to activate; an all-`review_all` version needn't be, and any model or category change resets automation to `review_all`.
10. **Security (docs/security.md):** document content is untrusted data (gates may send it to review, never approve it); stored files are served with a server-chosen type; webhook egress goes through the SSRF guard; secrets are encrypted at rest; security-relevant changes are audited in the same transaction; deletion goes only through `purge_document()`.

## When you change X, also do Y

| Change | Also |
|---|---|
| Add a tenant table (any public table with `tenant_id`) | `tenantKey()`, composite FKs to its parents, and RLS in a migration. `catalog.db.test.ts` fails otherwise |
| A model, effort, prompt, request builder or fixture | Requests change, so re-record cassettes: stop `pnpm dev`, then `LLM_MODE=record pnpm cassettes:record --yes`. The demo, replay e2e and recorder share `DEMO_MODEL` |
| A request builder | Content and config only; no tenant ids, keys or addresses (a test checks that the cassette hash ignores the tenant) |
| Add a model | A `MODEL_CATALOG` entry (`packages/core/src/models.ts`) and a `MODEL_PRICE_SEED` row (`packages/db/src/seed/prices.ts`) |
| Add a queue | Add it to `QUEUES` in core; `db:migrate` creates it |
| A pipeline stage handler | Commit order: guarded status advance, stage result, pointers, `markCanonical`, then enqueue |
| The eval runner (`apps/worker/src/evals/`) | No `createAction`, `enqueue` or delivery imports; a source scan and a type test enforce this |
| A built-in category (template) | Built-ins are code with rules; keep `BUILTIN_CATEGORY_NAMES` (schemas), `BUILTIN_CATEGORIES` (core) and `TEMPLATES` equal (`categories.db.test.ts`). Tenants' own types are data: definitions in `packages/schemas/src/definition.ts`, created in Settings → Categories |
| How a definition compiles (`compileDefinition`) | Stored versions are insert-only, so old versions keep their schema. Keep the output inside `toApiSchema`'s subset (`definition.test.ts` runs every starter) |
| Optional OCR (`core/pipeline/ocr.ts`, `deploy/compose.ocr-*.yaml`) | It runs inside `parseSource`, so production and evals OCR alike. Requests change only for `ocr_text` parts, never with OCR off. Pin new model files by revision and SHA-256 in `cli ocr-model` |
| A public API route (`/api/v1`) | snake_case like the webhook payload, a scope check (`requireScope`), and docs/api.md |
| What an installation runs (`deploy/`, `install.sh`, `cli configure`) | `scripts/install-smoke.sh` (CI's install-smoke) and docs/install.md. An installation's compose project is never `ai-triage`: that's the repository's demo and dev stack |
| A package that web imports | Add it to `transpilePackages` in `apps/web/next.config.ts` |
| Add a document-derived table | Add it to `purge_document()` (a new migration replacing the function), or purges fail on the FK |
| Log or measure something | `log` from `apps/{api,worker}/src/{log,observe}.ts` (never `console.*`; lines get the trace id), metrics on their `registry`. Add a new metric to docs/operations.md |
| Read a new environment variable | Register it in `packages/core/src/env.ts`, then `pnpm config:docs`. `env.test.ts` fails on an unregistered `process.env.X` or a stale `.env.example` |
| A command the image should run | Add its entry to `apps/worker/tsup.config.ts` (`bin/<name>`); `entrypoint cli <name>` runs it. Anything read from disk at runtime needs a `COPY` in the Dockerfile's runtime stage |
| A Better Auth table | Keep BA's model and field names, and use `uuid().defaultRandom()` ids |
| An encrypted column (`encryptSecret`) | Re-encrypt it in `pnpm secrets:rotate-key` (`packages/db/src/bin/rotate-key.ts`) |
| Add a mail provider | `MAILBOX_PROVIDERS` and `MAILBOX_AUTHSERV_IDS` in core, a client in `packages/mailbox/src/<provider>/`, and a fake beside `testing/fake-google.ts` |
| Call Google (OAuth or Gmail) | Go through `packages/mailbox` with an injected `fetch` (tests use `FakeGoogle`); never hold a transaction across the call |

## Gotchas

- tsup bundles CommonJS deps such as `pg` into the ESM output. So api and worker add a `createRequire` banner (`apps/worker/tsup.shared.ts`); without it, `node dist/index.js` fails with "Dynamic require of "events" is not supported".
- The runtime image is Alpine (musl). Next traces `sharp` (glibc) into its standalone output even with `images.unoptimized`, so the Dockerfile deletes it; don't add `next/image` or another native module without changing that.
- Better Auth's `disableSignUp` also blocks server-side `signUpEmail`, so seeds and tests use `ensurePasswordUser()`.
- Better Auth's TOTP step only follows `/sign-in/email`. `packages/db/src/auth-oauth-2fa.ts` repeats it after a Google callback by writing the twoFactor plugin's own cookie and verification rows, so keep `better-auth` pinned; `google-auth.db.test.ts` fails if those internals move.
- Google sign-up goes through one gate, `admissionRefusal()` (`packages/db/src/admission.ts`), called from Better Auth's `user.create.before` hook. Don't add `trustedProviders: ["google"]`: it would let Google link an account whose email Google didn't verify.
- Better Auth with `generateId: "uuid"` leaves `id` out of inserts, so every auth table needs `uuid().defaultRandom()`.
- An installation must not share a compose project name with another stack: compose identifies a stack by name alone, so a second `up` takes over its containers and volumes (`./triage` refuses to). Installs default to `ai-triage-install`.
- `docker compose up --wait` treats an exited one-shot service as a failure. So `infra:up` waits only on the long-running services, then runs `storage-init` with `run --rm`.
- Local S3 is RustFS, because MinIO stopped publishing images. The bucket is created with `curl --aws-sigv4`.
- TypeScript 7 (the native compiler) is in use.
- In the fixture generator, random draws happen outside the file-writing callbacks.
