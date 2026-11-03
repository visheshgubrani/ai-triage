# Security

> The threat model, the controls that answer it, and what an operator must set before going live. Controls land in phase 5 (milestones M1–M8, [architecture.md](architecture.md) §9). The **Status** column tracks them.

ai-triage has to be safe both **self-hosted** (one company per instance) and **hosted** (many companies as tenants of one instance). The hosted case is the stricter one, so it sets the bar.

## Assets

- **Tenant documents and emails:** invoices, contracts, support mail. They hold personal data, bank details and commercial terms. Copies live in storage, `document_parts`, `extractions`, `actions.payload`, `review_decisions` and `llm_calls.response`.
- **The approval decision.** An approved item fires a signed webhook into the tenant's systems (an ERP, a ticket queue). A wrong auto-approval is the most expensive failure: a spoofed invoice paid, or a contract filed as signed.
- **Secrets:** webhook signing secrets, tenant API keys, session cookies, provider API keys (deployment env), `BETTER_AUTH_SECRET`, the encryption key ring.
- **Spend:** each tenant's daily LLM budget, and the operator's provider accounts.
- **The internal network** the worker can reach: Postgres, storage, the API, cloud metadata.

## Actors

| Actor | Can | Wants |
|---|---|---|
| Anyone on the internet | Reach the web, API and Postmark endpoints | Accounts, data, spend |
| **Any email sender** | Put arbitrary content into the pipeline, by mailing an inbound address | Auto-approval of a forged document (invoice fraud), prompt injection, budget exhaustion, XSS through attachments |
| Viewer / reviewer | Read their tenant's data; reviewers decide tasks | Act beyond their role |
| **Tenant admin (hosted)** | Configure webhooks, configs and keys for their tenant | Reach other tenants' data or the operator's network (SSRF) |
| Webhook receiver | Gets signed payloads | Replay or forge deliveries |
| Compromised dependency | Run code at install or runtime | Everything |

## Trust boundaries

1. **Browser → API.** Cookie sessions (Better Auth). Every request re-checks membership and role, and every tenant query runs under RLS (`withTenantTx`).
2. **Email / API client → ingest.** Postmark basic auth, or a tenant API key. **Content is always untrusted**, whoever sends it.
3. **Document content → model.** Text and files are data, never instructions. Deterministic gates decide routing; the model's opinion of itself (`self_confidence`, `uncertain_fields`) is only one input.
4. **Worker → the outside world.** Model providers, and webhook URLs that a tenant chose.
5. **Storage → browser.** Presigned URLs serve tenant files on the storage origin.

## Controls

| Area | Control | Status |
|---|---|---|
| Tenant isolation | RLS (ENABLE + FORCE) on every tenant table, composite FKs that include `tenant_id`, an app role that can't bypass RLS (`assertAppRole`), server-issued storage keys, SECURITY DEFINER resolvers for pre-tenant lookups | Done (phase 1–2) |
| Approvals | Exact revision + claim token, a payload frozen at approval, actions per task kind enforced by the API, an insert-only `review_decisions` trail | Done (phase 3) |
| Auto-approval blast radius | Opt-in per category, an audit sample, scans and images always go to review, no tools on model calls | Done (phase 2–3) |
| Email HTML | Sanitized server-side, rendered in a sandboxed `srcdoc` iframe with a CSP that blocks remote loads | Done (phase 3) |
| Webhook redirects | Not followed; a 3xx fails the delivery | Done (phase 3) |
| HTTP headers | API: `secureHeaders`, a JSON-only CSP, HSTS on https. Web: nonce CSP, nosniff, Referrer-Policy, Permissions-Policy | Done (M1) |
| CSRF | Origin check on every cookie-authenticated unsafe request, alongside SameSite=Lax | Done (M1) |
| Request limits | A 1 MiB body limit on JSON routes; request IDs | Done (M1) |
| Safe startup | Production refuses default secrets, a non-https auth URL, http webhooks and demo users, unless `TRIAGE_DEMO=true` | Done (M1) |
| Auth surface | Only the Better Auth endpoints the web uses are mounted; Secure cookies on https; 12-character passwords | Done (M1) |
| Postmark auth | Constant-time credential check | Done (M1) |
| Audit log | Insert-only `audit_events`, written in the same transaction as the change: settings, keys, configs, redeliveries, purges, 2FA | M2 |
| SSRF | Webhook URLs must be https, on allowed ports, resolving to public addresses. Checked at save time **and at connect time** (DNS rebinding). An explicit allowlist for internal receivers | M3 |
| Webhook secrets | AES-256-GCM at rest, with a key ring and the tenant id as AAD. Rotation keeps the old secret valid for 24 h | M3 |
| Webhook signature | v2 signs the timestamp, the Idempotency-Key and the body | M3 |
| Abuse | Database-backed rate limits (auth, Postmark, REST, uploads, review), an admin-editable daily budget | M4 |
| Served files | Presigned GETs force a content type: the sniffed type for PDFs and images, `application/octet-stream` + `attachment` for everything else | M5 |
| Uploads | Presigned PUTs sign Content-Length; rejected objects are deleted; `.eml` needs an email MIME | M5 |
| Email intake | Attachment count and size caps; routing by envelope recipient; unguessable, rotatable inbound addresses | M5 |
| Parsers | DOCX zip-bomb checks, an image pixel cap, the existing PDF page cap | M5 |
| Prompt injection | Part delimiters escaped; an `injection_suspected` gate forces review | M5 |
| Sender spoofing | SPF/DKIM/DMARC results stored at ingest; the `sender_unauthenticated` gate keeps unauthenticated mail out of auto-approval | M5 |
| Accounts | TOTP 2FA (required for admins), session list and revoke, API keys with expiry and revocation from the UI | M6 |
| Privacy | Document purge, per-tenant retention, expired-upload cleanup, tenant offboarding | M7 |
| Supply chain | Least-privilege CI, SHA-pinned actions, CodeQL, `pnpm audit`, Dependabot, a minimum release age, digest-pinned images, a read-only app tree in the container | M8 |

## Deliberate non-goals and residual risks

- **The model can still be fooled.** Gates catch forged structure, missing evidence, failed arithmetic, injection phrasing and unauthenticated senders. They can't prove that a well-formed, authenticated document from a real sender is honest. Automation is opt-in per category, and the audit sample measures how often it is wrong.
- **Evidence matching proves a quote exists, not that it supports the value.**
- **API keys are SHA-256 hashed without a pepper.** They carry 192 bits of randomness, so a leaked hash can't be brute-forced.
- **Eval snapshots outlive a purged document.** They are copies a human chose to keep. Erasing eval items comes later.
- **Postmark doesn't sign inbound webhooks.** Basic auth over HTTPS is the control. Put the endpoint behind TLS and keep the password long.
- **Providers see document content.** Choose providers and data-processing terms to match your data. A `compat` server keeps it on your own hardware.

## Production checklist

Set these before exposing an instance. `TRIAGE_DEMO` must be unset; the api and worker refuse to start on the dev defaults.

- [ ] TLS in front of web and API, with HSTS on the web's TLS terminator (the API sends its own). `BETTER_AUTH_URL` and `WEB_ORIGIN` are `https://` URLs, and `NODE_ENV=production`.
- [ ] `pnpm db:migrate` (it also seeds model prices).
- [ ] `BETTER_AUTH_SECRET`: at least 32 random bytes (`openssl rand -base64 32`).
- [ ] `ENCRYPTION_KEYS` (or `ENCRYPTION_KEY`): 32 random bytes, base64. Back it up apart from the database; losing it loses the webhook secrets.
- [ ] Postgres: strong passwords for the owner (`DATABASE_OWNER_URL`) and app (`DATABASE_URL`) roles. The app role is never the owner.
- [ ] S3: a private bucket, credentials scoped to it, server-side encryption on.
- [ ] `POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASSWORD`: long and random.
- [ ] `TRUSTED_PROXIES`: the addresses (or CIDRs) of the proxies in front of the API, so rate limits and audit IPs see the real client.
- [ ] `WEBHOOK_ALLOWED_HOSTS`: only if a receiver lives on a private network.
- [ ] No demo seed. `pnpm db:seed` loads demo users, and production refuses it.
- [ ] Backups for Postgres and the bucket, with restores tested.
- [ ] GitHub: secret scanning with push protection, and private vulnerability reporting.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
