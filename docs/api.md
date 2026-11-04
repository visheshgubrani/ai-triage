# Public API and webhooks

Two directions:
- **In:** other systems send documents with the REST API. Email arrives by Postmark or Gmail sync instead; see [install.md](install.md).
- **Out:** each approved document is POSTed to your webhook.

The REST API also lets a sender check what happened to a document. That matters because the webhook fires only on approval: it says nothing while a document waits in review, or when it fails, is skipped or is rejected.

Every path below is relative to your installation's address, for example `https://triage.example.com`.

## Authentication

An admin creates keys in **Settings → API keys**, or runs `pnpm api-key:create --tenant <slug> [--scopes ingest,read]`. Send the key as a bearer token:

```bash
export TRIAGE_URL=https://triage.example.com
export TRIAGE_API_KEY=tri_…   # shown once, when the key is created
```

| Scope | Allows |
|---|---|
| `ingest` | `POST /api/v1/documents` |
| `read` | `GET /api/v1/documents…` and `GET /api/v1/categories` |

- New keys get both scopes unless "Can read documents" is unticked. A key that only sends documents, such as one on a scanner or a mail relay, needn't be able to read extracted data.
- Keys created before scopes existed have only `ingest`.
- A call outside the key's scopes returns `403 {"code": "missing_scope"}`.
- Keys can expire, and they stop working the moment they're revoked.

## Send a document

```bash
curl -X POST "$TRIAGE_URL/api/v1/documents" \
  -H "Authorization: Bearer $TRIAGE_API_KEY" \
  -F file=@invoice.pdf \
  -F external_ref=PO-4500012345
```

- **Accepted files:** PDF, DOCX, PNG, JPEG, plain text, and `.eml` (a whole email, attachments included), up to `MAX_FILE_MB` (20 MB by default).
- **`external_ref`** is optional: your own id for the document, up to 200 characters. You can look the document up by it later.
- **Answers:**
  - `201 {"documentId": "…", "duplicate": false}` for a new document.
  - `200` with `"duplicate": true` when the same content was already sent. The answer then carries the first document's id, and nothing is processed twice, so retries are safe.

## Look up a document

```bash
curl "$TRIAGE_URL/api/v1/documents/<documentId>" -H "Authorization: Bearer $TRIAGE_API_KEY"
curl "$TRIAGE_URL/api/v1/documents?external_ref=PO-4500012345" -H "Authorization: Bearer $TRIAGE_API_KEY"
```

The first returns one document. The second returns `{"documents": [...]}`, newest first. It's normally one document, but a reference used more than once lists each.

```json
{
  "id": "1d0c…",
  "external_ref": "PO-4500012345",
  "created_at": "2026-11-04T09:12:44.120Z",
  "state": "needs_review",
  "processing_status": "done",
  "review_status": "pending",
  "delivery_status": "none",
  "category": "invoice",
  "fields": { "vendor_name": "Northwind Supplies", "total": 120 },
  "reasons": ["below_threshold"],
  "delivered_at": null
}
```

| `state` | Meaning |
|---|---|
| `processing` | Still in the pipeline (parse, classify, extract, route) |
| `needs_review` | Waiting for a person. `reasons` says why: gate failures, low confidence, automation off for the category |
| `approved` | Approved by a person, or automatically. The webhook delivers it; `delivery_status` and `delivered_at` track that |
| `rejected` | A reviewer rejected it. No webhook |
| `failed` | The pipeline couldn't process it. `reasons` holds the failure reason, such as `unsupported_file` or `provider_unavailable`. An admin can retry it |
| `skipped` | An intake filter held it back before any model call (`auto_replies`, `bounces`, `bulk`) |

`fields` holds the current extraction: the model's, or a reviewer's edit once there is one. Its shape is the category's schema.

## Categories and their schemas

```bash
curl "$TRIAGE_URL/api/v1/categories" -H "Authorization: Bearer $TRIAGE_API_KEY"
```

This returns `{"categories": [{"name", "origin", "version", "description", "json_schema"}]}` for the active pipeline:
- the built-ins (`invoice`, `support_request`, `contract`);
- any category defined in Settings → Categories (`origin: "custom"`).

Use `json_schema` (draft 2020-12) to validate or generate types for webhook payloads. When an admin edits a category, its `version` goes up.

## Errors and limits

- **Error shape:** `{"error": "message", "code": "…"}`, with `issues` for validation errors.
- **Statuses:**

  | Status | Meaning |
  |---|---|
  | 400 | Invalid request |
  | 401 | Missing, unknown, revoked or expired key |
  | 403 | `missing_scope` |
  | 404 | Not found, including another workspace's id |
  | 413 | File too large |
  | 415 | Unsupported file type |
  | 429 | Rate limited, with `Retry-After` |
- **Rate limit:** 120 requests a minute per key, scaled by the operator's `RATE_LIMIT_SCALE`.
- **Request id:** every response carries `X-Request-Id`. Quote it when reporting a problem; the server logs carry the same id.

## Webhook receiver contract

Set the URL in **Settings → Webhooks**. **Send test event** posts a signed `ping` and shows your receiver's answer.

Each approved document is POSTed as JSON (the action payload: `document_id`, `extraction_id`, `category`, `fields`, `approved_by`, `approved_at`) with these headers:

- **`Idempotency-Key`:** the action id. **Delivery is at least once**, and a manual Redeliver sends the same key, so dedupe on it.
- **`X-Triage-Event`:** `document.approved`, or `ping` for a test event (body `{"type": "ping", "tenant", "sent_at"}`; answer 2xx and do nothing).
- **`X-Triage-Signature`:** `t=<unix seconds>,v2=<hex>`.
  - `v2` is HMAC-SHA256 of `<t>.<Idempotency-Key>.<raw body>`, keyed with the workspace's signing secret.
  - For 24 hours after a secret rotation, the header carries one `v2` per secret, newest first. Accept the delivery if any of them verifies with the secret you hold.

Verify against the **raw** body (before JSON parsing), reject stale timestamps, then dedupe:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, idempotencyKey, rawBody, toleranceSeconds = 300) {
  const pairs = header.split(",").map((kv) => kv.split("=", 2));
  const t = pairs.find(([k]) => k === "t")?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${idempotencyKey}.${rawBody}`).digest();
  return pairs
    .filter(([k]) => k === "v2")
    .some(([, hex]) => {
      const given = Buffer.from(hex ?? "", "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

```python
import hashlib, hmac, time

def verify(secret: str, header: str, idempotency_key: str, raw_body: bytes, tolerance: int = 300) -> bool:
    pairs = [kv.split("=", 1) for kv in header.split(",") if "=" in kv]
    t = next((v for k, v in pairs if k == "t"), None)
    if t is None or abs(time.time() - int(t)) > tolerance:
        return False
    signed = f"{t}.{idempotency_key}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in pairs if k == "v2")
```

To dedupe, store the `Idempotency-Key` in the same transaction as the side effect (for example, a unique column on the row you create), so a redelivery does nothing.

**Where it can deliver:**
- Public `https://` hosts on port 443, 8443, or any port above 1023.
- The API refuses private, loopback and metadata addresses when the URL is saved, and the worker checks again at every connection.
- Receivers on a private network go in the operator's `WEBHOOK_ALLOWED_HOSTS` (hostnames or CIDRs, which may also use http).

**Retries:**
- Answer 2xx to accept.
- These are retried with exponential backoff (8 retries, starting at 30 s): 5xx, 408, 425 and 429 answers, timeouts (10 s), and network errors.
- Any other 4xx, or a redirect, fails the delivery at once. It then waits under Delivery failures for a Redeliver.
