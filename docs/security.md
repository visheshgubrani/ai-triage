# Security

> The threat model, the controls that answer it, and what an operator must set before going live. The controls landed in phase 5 (milestones M1–M8, [architecture.md](architecture.md) §9).

ai-triage has to be safe both **self-hosted** (one company per instance) and **hosted** (many companies as tenants of one instance). The hosted case is the stricter one, so it sets the bar.

## Assets

- **Tenant documents and emails:** invoices, contracts, support mail. They hold personal data, bank details and commercial terms. Copies live in storage, `document_parts`, `extractions`, `actions.payload`, `review_decisions` and `llm_calls.response`.
- **The approval decision.** An approved item fires a signed webhook into the tenant's systems (an ERP, a ticket queue). A wrong auto-approval is the most expensive failure: a spoofed invoice paid, or a contract filed as signed.
- **Secrets:** Gmail **mailbox refresh tokens** (read access to a whole mailbox: the most sensitive secret here), webhook signing secrets, tenant API keys, session cookies, provider API keys (deployment env), `BETTER_AUTH_SECRET`, the encryption key ring.
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
| Someone with a leaked invitation link | Open the invite page | Join a tenant as the invited role (only when the invite allows a password) |
| A Google account holder | Sign in with Google, consent to a mailbox | Get a user or a membership without an invitation; claim another company's domain |
| Compromised dependency | Run code at install or runtime | Everything |

## Trust boundaries

1. **Browser → API.** Cookie sessions (Better Auth). Every request re-checks membership and role, and every tenant query runs under RLS (`withTenantTx`).
2. **Email / API client → ingest.** Postmark basic auth, or a tenant API key. **Content is always untrusted**, whoever sends it.
3. **Document content → model.** Text and files are data, never instructions. Deterministic gates decide routing; the model's opinion of itself (`self_confidence`, `uncertain_fields`) is only one input.
4. **Worker → the outside world.** Model providers, and webhook URLs that a tenant chose.
5. **Storage → browser.** Presigned URLs serve tenant files on the storage origin.
6. **Google → API.** OAuth callbacks (Better Auth's for sign-in, `/integrations/google/callback` for mailboxes and domains) and the worker's Gmail calls. Google's identity claims are trusted only from its token endpoint over TLS.

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
| Audit log | Insert-only `audit_events`, written in the same transaction as the change: settings, keys, configs, redeliveries, purges, 2FA | Done (M2) |
| SSRF | Webhook URLs must be https, on allowed ports, resolving to public addresses. Checked at save time **and at connect time** (DNS rebinding). An explicit allowlist for internal receivers | Done (M3) |
| Webhook secrets | AES-256-GCM at rest, with a key ring and the tenant id as AAD. Rotation keeps the old secret valid for 24 h | Done (M3) |
| Webhook signature | v2 signs the timestamp, the Idempotency-Key and the body | Done (M3) |
| Abuse | Postgres-backed fixed-window limits shared by every api process: sign-in per address and per account, other auth endpoints per address, inbound email per tenant, the REST API per key, uploads and every other write per user (429 + Retry-After; `RATE_LIMIT_SCALE` raises them all). An admin-editable daily LLM budget | Done (M4) |
| Served files | Presigned GETs force a content type: the sniffed type inline for PDFs and raster images, `application/octet-stream` + `attachment` for everything else, so no stored file runs as script on the storage origin | Done (M5) |
| Uploads | Presigned PUTs sign Content-Type and Content-Length (storage refuses other sizes); refused uploads are deleted; an `.eml` name needs an email or octet-stream type | Done (M5) |
| Email intake | At most 25 attachments, each within the file limit (Postmark gets a 403, which it doesn't retry); the tenant is chosen by the envelope recipient, never by To/Cc; unguessable inbound addresses that admins can replace (audited) | Done (M5) |
| Parsers | DOCX zip-bomb check from the central directory (≤ 5000 entries, ≤ 50 MB uncompressed) before mammoth runs; images over 40 MP refused; the PDF page cap | Done (M5) |
| Parser isolation | PDF, DOCX and email parsing run in a sandboxed thread with a time limit (`PARSE_TIMEOUT_MS`) and a heap cap (`PARSE_MAX_MEMORY_MB`), so a hostile file can't hang or exhaust the worker | Done (phase 7, M4) |
| Prompt injection | `<part` / `</part` in document text escaped; a deterministic `injection_suspected` gate (pipeline/untrusted.ts) sends text that addresses the triage system to review | Done (M5) |
| Sender spoofing | Authentication-Results headers stored with each email; the `sender_unauthenticated` gate trusts only headers from receiving servers the config names (`policy.sender.trustedAuthServIds`) and needs DMARC (or DKIM) pass. **Opt-in per config** for forwarded mail; on by default for Gmail-synced mail (phase 6) | Done (M5, phase 6) |
| Accounts | TOTP 2FA with backup codes (Better Auth `twoFactor`; code checks rate-limited, BA locks out repeated failures); admin-only routes need it when `REQUIRE_ADMIN_2FA` is on (the default outside the demo); session list and revoke; a password change signs out other sessions; API keys created, listed (prefix only) and revoked from Settings, with optional expiry, and scoped: `ingest` and/or `read` (keys from before scopes keep only `ingest`). All audited | Done (M6, scopes phase 7) |
| Privacy | `purge_document()`: a SECURITY DEFINER function owned by `app_purger`, the only role the immutability guards let delete, deletes a document and everything derived from it within the caller's tenant; its objects are deleted by a `storage.delete` job enqueued in the same transaction. Admins delete documents (audited with the id and a hash of the external id). Per-tenant retention purges finished documents nightly; abandoned uploads are dropped; `pnpm tenant:delete` offboards a tenant | Done (M7) |
| Sign-up and sign-in | No public sign-up: Google creates a user only for a verified email that holds a pending invitation, or a Workspace account (`hd`) of a claimed domain. Linking needs an email verified by Google **and** locally. A Google sign-in asks for TOTP like a password one; a passwordless 2FA change needs a sign-in from the last 10 minutes. Google tokens from sign-in aren't stored | Done (phase 6) |
| Invitations | Random 32-byte tokens in the URL fragment (never logged or sent as Referer), stored as SHA-256, single use, 7-day expiry, revocable, rate-limited lookups. Google-only by default; password acceptance leaves the user unverified. Audited | Done (phase 6) |
| Members | Role changes and removals keep an admin (row lock); removal ends access on the next request. Workspace domains are claimed only with a Workspace account in the domain, one tenant each, auto-join never as admin and only at user creation | Done (phase 6) |
| Mailbox OAuth | PKCE, a `state` used once by the admin who started it within 10 minutes (RLS-scoped), `gmail.readonly` only, a grant without Gmail access refused and revoked. Tokens encrypted with the key ring (AAD per connection), covered by `secrets:rotate-key`, revoked at Google on disconnect and tenant deletion | Done (phase 6) |
| Gmail sync | Ledger of ids only; drafts, sent, spam and oversized mail skipped; the tenant's inbound limit applies; Google's own Authentication-Results are found by position and the sender gate is **on by default** for synced mail | Done (phase 6) |
| Supply chain | CI with read-only permissions and SHA-pinned actions; `pnpm audit` (high fails); CodeQL (security-extended); Dependabot for npm, actions and images; `minimumReleaseAge` of a day; digest-pinned base images; app files in the container owned by root | Done (M8) |

## Deliberate non-goals and residual risks

- **The model can still be fooled.** Gates catch forged structure, missing evidence, failed arithmetic, injection phrasing and (where the config requires it) unauthenticated senders. They can't prove that a well-formed, authenticated document from a real sender is honest. Automation is opt-in per category, and the audit sample measures how often it is wrong.
- **Evidence matching proves a quote exists, not that it supports the value.**
- **OCR'd text is document content, so it's untrusted like the rest.**
  - The OCR server runs inside the compose network with no published port, and receives only page images.
  - Its model files are pinned by Hugging Face revision and SHA-256 (`cli ocr-model`), and its image by digest.
  - A misread figure is checked like any other value: quotes are verified against the OCR'd text, and automation needs calibration.
- **API keys are SHA-256 hashed without a pepper.** They carry 192 bits of randomness, so a leaked hash can't be brute-forced.
- **Eval snapshots outlive a purged document.** They are copies a human chose to keep. Erasing eval items comes later.
- **Sender authentication depends on the forwarding path.** Forwarding breaks SPF, and a header any sender can write proves nothing, so for forwarded mail the gate needs the tenant to name the receiving server it trusts and is off by default. For Gmail-synced mail it is on, trusting Google's results by their position in the header block: that rule follows Gmail's documented layout and should be rechecked against real raw messages whenever Gmail changes its trace headers.
- **A mailbox token reads the whole mailbox.** It's encrypted at rest, but a stolen key ring plus a database copy exposes every connected mailbox. Back up and guard `ENCRYPTION_KEYS` accordingly; disconnecting revokes the grant at Google.
- **An invitation that allows a password is a bearer link.** Whoever opens it first gets the account. Prefer Google-only invitations, and send links privately.
- **Postmark doesn't sign inbound webhooks.** Basic auth over HTTPS is the control. Put the endpoint behind TLS and keep the password long.
- **Providers see document content.** Choose providers and data-processing terms to match your data. A `compat` server keeps it on your own hardware.

## Production checklist

Set these before exposing an instance. `TRIAGE_DEMO` must be unset; the api and worker refuse to start on the dev defaults.

- [ ] TLS in front of the app (Caddy, which routes `/api` to the api), with HSTS (the API sends its own). `PUBLIC_URL` is an `https://` origin, and `NODE_ENV=production`.
- [ ] `pnpm db:migrate` (it also seeds model prices).
- [ ] `BETTER_AUTH_SECRET`: at least 32 random bytes (`openssl rand -base64 32`).
- [ ] `ENCRYPTION_KEYS` (or `ENCRYPTION_KEY`): 32 random bytes, base64. Back it up apart from the database; losing it loses the webhook secrets.
- [ ] Postgres: strong passwords for the owner (`DATABASE_OWNER_URL`) and app (`DATABASE_URL`) roles. The app role is never the owner.
- [ ] S3: a private bucket, credentials scoped to it, server-side encryption on.
- [ ] `POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASSWORD`: long and random.
- [ ] `TRUSTED_PROXIES`: the addresses (or CIDRs) of the proxies in front of the API, so rate limits and audit IPs see the real client.
- [ ] `WEBHOOK_ALLOWED_HOSTS`: only if a receiver lives on a private network.
- [ ] Every admin turns on 2FA (Settings → Security); `REQUIRE_ADMIN_2FA` stays unset (on).
- [ ] `RATE_LIMIT_SCALE`: only if legitimate traffic hits the default limits (it multiplies them all).
- [ ] No demo seed. `pnpm db:seed` loads demo users, and production refuses it.
- [ ] A retention period (Settings → Retention) that matches your data policy.
- [ ] Backups for Postgres and the bucket, with restores tested (and expiring, so purged data leaves them too).
- [ ] Google (if used, [google.md](google.md)): the OAuth client's two redirect URIs, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the api **and** worker, no `GOOGLE_OAUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_API_URL`. An External app needs Google's restricted-scope verification before real users; Testing mode expires mailbox grants weekly.
- [ ] GitHub: secret scanning with push protection, and private vulnerability reporting.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
