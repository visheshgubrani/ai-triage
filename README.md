# ai-triage

An open-source AI triage inbox. Emails and documents come in, Claude classifies them and extracts structured, schema-validated fields, and anything uncertain goes to a human approval queue instead of being acted on. An evals page measures accuracy per category plus cost and latency per request.

> **Status: pipeline and review queue work; evals are next.** Documents are ingested, classified and extracted, uncertain ones go to a review queue, and approvals are delivered as signed webhooks. See [docs/architecture.md](docs/architecture.md) for the design.

## Stack

TypeScript · Hono (API) · Next.js (UI) · Postgres + Drizzle + pg-boss · S3-compatible storage (RustFS locally) · Claude API · pnpm + Turborepo · Biome · Vitest

## Getting started

Requires Node ≥ 24, pnpm 12 and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres on :5440, RustFS on :9020, a webhook catcher on :9030
pnpm db:migrate    # creates the app's database role, applies migrations, installs the job queue
pnpm db:seed       # model prices, a demo tenant and 60 synthetic documents
pnpm dev           # web http://localhost:3000 · api http://localhost:8787
```

Sign in at http://localhost:3000/sign-in as `admin@demo.test` or `reviewer@demo.test`, with the password `demo-password`. These are **dev-only** demo credentials created by the seed.

The app connects to Postgres as a restricted role (`DATABASE_URL`), so row-level security always applies. Only migrations and seeds use the owner (`DATABASE_OWNER_URL`).

LLM calls default to **replay mode** (recorded responses, no API key, no spend). Set `LLM_MODE=live` and `ANTHROPIC_API_KEY` to call Claude for real.

## Reviewing

Open http://localhost:3000/review as `reviewer@demo.test`. The queue lists documents waiting for a human, oldest first, with filters by kind, category, reason and age. **Claim next** (`n`) opens the oldest free task and claims it for 10 minutes; the page renews the claim while it's open. On the task page the source is on the left (the email, the PDF, and the extracted text with the model's quotes highlighted) and the extraction on the right, as a form with failed checks marked on their fields.

| Key | Action |
|---|---|
| `a` or `⌘↵` | Approve (**Save & approve** once you've edited a field: the edit becomes a new revision) |
| `r` | Reclassify: the model re-extracts with your category, and the task comes back for review |
| `x` | Reject (final: nothing is sent) |
| `t` | Retry a document whose processing failed |
| `n` | Skip to the next task |

Every approval binds to the exact revision on screen: if anything changed since (another tab approved it, the claim lapsed), the API refuses with 409 and nothing happens. Approved documents are delivered to the tenant's webhook; failures show under **Delivery failures** with **Redeliver**. Admins set the webhook at `/settings`.

Locally, the demo tenant's webhook points at the catcher: open http://localhost:9030 to see each delivery and whether its signature verifies. Add `?status=422` (or any code) to the webhook URL to make it fail.

## Webhook receiver contract

Each approved document is POSTed as JSON (the action payload: `document_id`, `extraction_id`, `category`, `fields`, `approved_by`, `approved_at`) with these headers:

- `Idempotency-Key`: the action id. **Delivery is at least once**, and a manual Redeliver sends the same key, so dedupe on it.
- `X-Triage-Event: document.approved`
- `X-Triage-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `<t>.<raw body>` with the tenant's secret.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2)));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Answer 2xx to accept. 5xx, 408, 425, 429, timeouts (10 s) and network errors are retried with exponential backoff (8 retries, starting at 30 s); any other 4xx or a redirect fails the delivery at once, and it waits under Delivery failures for a Redeliver.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm e2e` runs the Playwright demo walkthrough (review, edit, approve, stale tab refused, signed delivery, redeliver) against a running `pnpm dev`.

`pnpm test` includes database tests (tenant isolation, constraints, queue atomicity, auth), which run against a scratch `triage_test` database and need `pnpm infra:up`. `pnpm test:unit` runs without Postgres. CI runs everything on every push.

## License

MIT

## Known limits

- **Repeated model calls are possible.** Each response is saved as soon as it arrives and reused on retry, but a worker that crashes between Claude answering and that save pays for the call again on retry. Every attempt is kept for cost accounting, and only one is canonical.
- **Evidence matching proves a quote exists, not that it supports the value.** A verbatim quote must appear in the source (or on the cited PDF page); scans and images can't be checked, so they always go to review.
- **The prompt-injection fixtures are regression tests, not proof of resistance.** Triage calls have no tools, the only action is a webhook to a tenant-configured target, and automation is opt-in per category, which keeps the damage of a confidently wrong answer small.
- **Webhook targets are trusted to the tenant admin.** The URL isn't filtered against private networks (SSRF), and the signing secret is stored in plain text because it's needed to sign. Both are listed under "Later".
- **Inline email images (`cid:`) and remote images aren't shown** in the review view: the HTML is sanitized and rendered with a CSP that blocks remote loads.
- **Replay figures are recorded figures.** In replay mode, tokens, cost and latency come from the cassette, and are labeled as such (`llm_calls.mode = 'replay'`).
