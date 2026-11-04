# ai-triage pre-launch review, round 2

**Verdict: Go.** A new company can install this, onboard a team, connect real Gmail (including a PDF attachment, pause and resume, and disconnect), and run a busy day of invoices, support mail and contracts through review to signed delivery. Classification and extraction on the live model were close to perfect.

The test found two launch blockers, and both are now **fixed and re-verified** on the installed app:

- **Approval skipped the schema check.** A reviewer could approve an extraction missing a required field, and it was delivered.
- **The REST API refused PDFs sent without a content type.**

What remains is polish (fixes 3 to 9). Every round-1 finding is fixed and re-verified.

Tested on 4 November 2026 on branch `settings-redesign` (round-1 fixes applied, uncommitted), built as a Docker image and installed with `install.sh` from the checkout. The fictional company is **Kestrel Supply Co.**, a 40-person wholesale distributor, with two people:

- Priya, the ops lead and admin.
- Sam, the AP clerk and reviewer.

All documents were synthetic, generated with known correct values. New documents ran on the live model (`openai:gpt-6.1-terra`, low effort). Each person used their own browser session; nothing was done through the database.

## The operator journey

| Task | Result | What happened |
| --- | --- | --- |
| Try the demo | Passed | `install.sh --demo` on a machine where 3000, 9020, 9030 and 9040 were already taken. It stopped on 3000 with "run again with `--port 4000`". With that flag it came up in 31 s and moved storage, catcher, fake Google and Postgres to free ports, then printed the real URLs and a ready `curl` for the fake Gmail. It ran as its own project; the dev stack was untouched. Re-running it was safe. The review, Gmail and evals walkthroughs (e2e) passed against it. |
| Install for the team | With one stop | The installer wrote `.env`, then stopped: "The compose project `ai-triage-install` already runs from …". That was an old, stopped install in another folder. The printed fix (`./triage config set COMPOSE_PROJECT_NAME=kestrel`) worked, and the stack was ready 17 s later. `./triage status` was clear: Google off, no workspace yet, and the fix for each. |
| Create the workspace | Passed | The setup link opened a short form and the short name filled itself in. The invitation page took a name and password, and the admin landed on the dashboard. |
| First admin, 2FA and checklist | Confusing | The dashboard showed **no Getting started checklist** and gave no hint that 2FA was needed. Settings showed a clear "Admin settings need two-factor authentication" with **Turn it on**, and TOTP setup (password, key or QR, backup codes, code) went smoothly. After that the checklist appeared, but **at the bottom** of the dashboard, below an empty chart and an empty documents list. |
| Webhook to the "ERP" | With docs | Settings → Webhooks explains the receiver contract well. A private receiver needed `WEBHOOK_ALLOWED_HOSTS`, which the page names. The URL must resolve before it saves, so the receiver had to exist first. **Send test event** reported "delivered: HTTP 200 in 27 ms", and the signature verified. |
| API key and REST intake | One failure | The key was created in Settings, shown once. Text and email went in fine. **PDFs sent without an explicit `Content-Type` were refused** with `415 unsupported type application/octet-stream`; the same files with `application/pdf` worked. |
| Busy day | Passed | 96 documents through the REST API (see below). None failed, none got stuck, and the duplicate was recognised. |
| Invite a reviewer | Passed | Members → Invite created a one-time link. Sam opened it in a separate browser, set a password and joined as reviewer. |
| Claim contention | Passed | Priya claimed an invoice. Sam opened the same task and saw "Claimed by priya@… until 9:59 PM. You can look, but not decide", with Reload. |
| Work the queue | Passed, one serious gap | Sam filtered to invoices and used `n` and `a`, then corrected a field and used Save & approve. Every next task was another invoice, and the queue said when the filter was cleared. Reject took a note. Reclassifying a support request came back as an invoice for review, with readable reasons ("Missing: Vendor name", "Reclassified"). **Approving an invoice with "Missing: Invoice number" went through and was delivered without the number** (finding 1). |
| Delivery and recovery | Passed | The ERP got the corrected vendor name, the right total ($72,566.43, matching the ground truth), `approved_by` Sam, and a valid signature. A forced HTTP 400 showed under **Delivery failures** with the receiver's error. **Redeliver** sent the same Idempotency-Key, got 200 with a valid signature, and cleared the row. |
| Search | Passed, with a gap | Documents search now applies as you type, with no Enter needed. But PDFs sent through the API are titled by filename (`inv-07.pdf`), so searching "Juniper" finds only the email invoices from that vendor (finding 3). |
| Real Gmail | Passed | Consent, read-only scope, "new mail only", self-sent mail skipped, intake from an outside sender (including a PDF attachment), label picker, pause and resume, disconnect with Google revocation (see below). |
| Phone width (390 px) | Passed | No sideways page scroll. The queue table scrolls inside its card. The task page shows the source text with highlighted quotes first, and Approve sits about one screen down. Usable, not optimised. |
| Operate it | Passed | `./triage status` (all checks with fixes), `backup` (504 KB, "holds your secrets: keep it private"), and `logs` (it follows the log, like `docker logs -f`). |

## The busy day

Kestrel's generated corpus held 97 files, each with its correct values:
- 40 supplier invoices: 30 PDFs with line items and 10 as email bodies, in USD, EUR and GBP, with and without tax and PO numbers.
- 35 customer support emails.
- 15 contracts as PDFs: NDA, MSA, lease, purchase and SOW.
- 2 off-topic emails.
- 4 edge cases: a total that doesn't add up, a missing invoice number, a prompt injection, and a duplicate.

They were sent through the REST API the way an integration would: 5 first, then 92 at once.

| Measure | Warm-up (5) | Burst (92) |
| --- | ---: | ---: |
| Time to send | - | 2.8 s |
| p50, sent to ready for review | 10 s | 89 s |
| p95 | 14 s | 147 s |
| Everything settled | 15 s | 150 s |
| Failed or stuck | 0 | 0 |

**Extraction quality against the ground truth** (this was the open question from round 1):

| Category | Result |
| --- | --- |
| Category, all documents | 96/96 |
| Invoices (44) | Every scored field right: vendor, number, dates, currency, subtotal, tax, total, PO |
| Contracts (15) | Type, parties, dates, term, value, currency and auto-renewal 15/15. Governing law came back as "State of Oregon" where the truth said "Oregon", which is equally correct |
| Support requests (35) | Customer, email, product, order and requested action 35/35. Severity 30/35: all five differences are one case type ("cancel a backordered item"), labelled medium and read as low, a judgment call |
| Duplicate PDF | Recognised; one document, not processed twice |
| Off-topic emails | Both "Unknown type", for a person |
| Prompt injection | Flagged "Suspicious instructions" and held for review |
| Missing invoice number | Flagged "Missing: Invoice number" |
| Total that doesn't add up | Not caught by the arithmetic rule (finding 7), but the model marked subtotal, tax and total uncertain, so it went to a person anyway |

**Cost:** $0.30 for 96 documents (190 model calls), about $0.003 a document, against the $5/day default budget.

## Real Gmail

The account was the project owner's own Gmail, connected to the test install through their OAuth client (consent screen in Testing).

- **Connect:** the redirect URI was right first time. Google's consent asked for read-only Gmail. The app said "Mailbox connected. New mail shows up within about a minute." Choosing "New mail only" imported none of the existing inbox.
- **Self-sent mail is skipped, correctly.** 12 test emails sent from the mailbox to itself all showed as "skipped (not incoming mail)". Gmail labels them SENT, and the app ignores a mailbox's own outgoing mail, which is right for a shared `ap@` inbox. The card lists skipped messages **with no subject or sender**, though, so an operator can't tell which emails were dropped (finding 8).
- **Intake from an outside sender:** 4 emails sent from another account became documents within about 2 minutes. They were marked "ingested" on the card, each with an Open document link. They passed sender checks, so none was flagged "Sender not verified". Both invoices matched the ground truth exactly: vendor, number, dates, total and every line item.
- **Label picker:** it loads the account's real labels live (INBOX, IMPORTANT, Personal, Receipts, Work…). Picking one saves at once. Closing the picker without picking left Inbox in place.
- **Pause and resume:** two more emails were sent while paused. Nothing came in over 2.5 minutes (five checks). On Resume, both arrived within 10 s, each exactly once.
  - One was a contract, extracted correctly in every field.
  - The other carried a **PDF attachment**. Its text was extracted and it was classified correctly: the PDF was a public notice, not a Kestrel document type, so "Unknown type". The model's rationale said why.
- **Disconnect:** the confirmation says "Its access at Google is revoked; documents already ingested stay." The card disappeared, all 6 Gmail documents were kept, and the audit log recorded connect, pause, resume and disconnect.
  - The stored event says `revokedAtProvider: true`, though the Audit log page doesn't show that detail.
- **Read state:** the app holds only `gmail.readonly`, which can't mark mail read, label it or delete it.

Not verified with real Gmail: the 7-day refresh-token expiry that a Testing consent screen causes, and reconnect after it.

## Round 1 findings: status

| Round 1 finding | Status |
| --- | --- |
| P1: the demo installer omits fake Google, the simulator and the webhook catcher | **Fixed and verified.** The demo starts all three and prints their real addresses and a ready `curl` for the fake Gmail. It also now runs as its own compose project, `ai-triage-demo`. Before, it shared the repository's `ai-triage` project, so its printed `docker compose down -v` would have deleted a dev stack's data. |
| P2: a port collision has no in-place recovery | **Fixed and verified.** `--port` moves the app. The other ports move past ones in use by themselves and are kept in the demo's `.env`, so a re-run is safe. Verified with 3000, 9020, 9030 and 9040 all taken. `install-smoke.sh` gained a demo case. |
| P2: internal reason codes at the point of decision | **Fixed and verified.** Reasons read "Sender not verified", "Missing: Issue summary", "Invalid value: Parties" and so on, in the queue, its filters, the task page, documents and Health. Hovering shows what each means and the original code. The task page now explains sender and injection failures in words. |
| P3: approving from a filtered queue jumps to other work | **Fixed and verified.** Filters live in the URL and travel with each task. Approve, reject and skip claim the next task from the same filter. When none is left, the queue says "You've cleared everything that matches these filters"; after a skip it says "Nothing else to claim". |
| P3: title search has no cue to submit | **Fixed and verified.** Search applies 300 ms after typing stops, and Enter applies it at once. |
| Sign-off: first admin, 2FA, reviewer invitation in an independent session, empty-workspace checklist, Gmail guidance, claim contention with two identities | **Done.** The checklist and Gmail guidance problems are findings 4 and 5. |
| Sign-off: real Gmail | **Done**, except token expiry and reconnect. |
| Sign-off: 390 px viewport | **Done.** Usable. |

## Ranked fixes

1. **P1 · Plain approval skips the schema check. Fixed and verified.**
   - **Repro:** open an invoice whose reasons include "Missing: Invoice number", press `a`. It's approved and the webhook delivers it with no `invoice_number`, although `/api/v1/categories` publishes that field as required.
   - **Cause:** edited values are validated against the full schema (`editRevision`, [apps/api/src/review.ts:323](../apps/api/src/review.ts)), but a plain `approve` of the model's revision isn't. Typing the same values by hand would be refused with `invalid_fields`.
   - **Fix (done):** every approval, plain or edited, now checks that required fields are filled and values match the schema. Category rules still don't block. A refusal returns `invalid_fields` and marks the fields: "Some fields are missing or invalid; they're marked below. Fill them in, or reject the document."
   - **Re-verified on the install:** Sam's `a` on an invoice with no number was refused and the field marked. After he typed the number, Save & approve delivered it with that number and a valid signature. An API test covers it.
2. **P1 · The REST API refuses PDFs without an explicit content type. Fixed and verified.**
   - **Repro:** `POST /api/v1/documents` with a `.pdf` as `application/octet-stream`, or with no type, which many HTTP clients, scanners and mail relays send. The answer is `415 unsupported type application/octet-stream`. An `.eml` sent the same way is accepted, because it's recognised by filename ([packages/ingest/src/index.ts:239-245](../packages/ingest/src/index.ts)).
   - **Fix (done):** when the declared type is missing or generic (`application/octet-stream`), it's inferred from the first bytes: `%PDF-`, PNG, JPEG, a zip named `.docx`, and valid UTF-8 named `.txt` ([packages/ingest/src/sniff.ts](../packages/ingest/src/sniff.ts)). A file declared as something else, such as a zip, is still refused.
   - **Re-verified on the install:** the same untyped PDF that got 415 now returns 201 and is processed. Unit and API tests cover it.
3. **P2 · Search can't find PDF documents by what they are.**
   - Documents sent by API or upload are titled by filename, so searching a vendor name finds only email invoices.
   - **Fix:** give documents a title from the extraction (for example "Invoice HOS20268479 · Halvorsen Office Supply") once one exists, or search extracted vendor, number and customer too.
4. **P2 · A new admin gets no guidance until they find 2FA.**
   - The Getting started checklist silently doesn't render while `/onboarding` answers 403 (2FA required). The dashboard says "Nothing needs you right now".
   - Once 2FA is on, the checklist sits below the empty chart and documents list.
   - **Fix:** in an empty workspace, show the checklist first, with "Turn on two-factor authentication" as step 1 when it's required.
5. **P2 · The Mailboxes page doesn't say how to set Google up.**
   - "An operator sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on this instance (docs/google.md)" names neither the command nor the redirect URIs, and wrong URIs are the usual first failure.
   - **Fix:** show `./triage config set GOOGLE_CLIENT_ID=…` and the two exact redirect URIs for this `PUBLIC_URL`, with a copy button.
6. **P2 · A second installation on one machine stops halfway.**
   - The default project name `ai-triage-install` is taken by any earlier install, even a stopped one. The installer writes `.env` and then stops. The fix it prints works, but the installer could pick a free name itself (from the folder, or `ai-triage-install-2`).
7. **P3 · The totals rule misses a total that doesn't add up when tax is absent.**
   - "Subtotal $1,394.60, Tax: none, Total $1,439.60" passes, because `totals_add_up` skips when `tax` is undefined, and `line_items_sum` compares against the subtotal.
   - Caught in practice by the model's uncertainty.
   - **Fix:** treat a missing tax as 0 when both subtotal and total are present.
8. **P3 · The Gmail card can't say what it skipped.**
   - "Recent messages" lists "skipped (not incoming mail)" with no subject or sender.
   - **Fix:** show the subject and sender, and explain that mail the mailbox sent itself is skipped.
9. **P3 · Small polish:**
   - **Slug check:** the setup form's slug pattern is invalid under the browser's `v` flag, so the check is silently off ([setup-view.tsx:97](../apps/web/src/app/(auth)/setup/setup-view.tsx)). The fix is to escape the hyphen.
   - **Copy:** "Claimed by priya@…test. until 9:59 PM" has a stray period ([review-view.tsx:137](../apps/web/src/app/(app)/review/[taskId]/review-view.tsx)).
   - **Jargon:** the dashboard shows "4/4 ≥51%" with no explanation, and Evals leads with calib, Freeze and Wilson bound.
   - **Severity:** "please cancel a backordered item" reads as low severity; the prompt could say that cancellations are medium when an order is affected.

## Sign-off still needed

- A reconnect after Google revokes or expires the token (Testing consent screens expire refresh tokens after 7 days).
- Publishing the image: these results are from a local build of `settings-redesign`, not a release.
