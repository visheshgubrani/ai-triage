// @ai-triage/core/review: pure helpers for the review queue, shared by the api and the web app.
// No imports beyond the closed sets, so it is safe in the browser.

import type { FailureReason, GateCode, IntakeFilter, RouteReason } from "./index";

/** One changed top-level field between two revisions. */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal. Arrays keep their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Top-level fields whose values differ (arrays are compared whole; null and absent are the same).
 * Stored with each edit, and used to tell whether an audited approval changed a required field.
 */
export function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .filter((f) => canonical(before[f]) !== canonical(after[f]))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

// The parts of `extractions.gate_results` the review page reads (see @ai-triage/core/pipeline).
export interface GateFailureLike {
  code: string;
  field?: string;
  detail?: string;
}
export interface RuleResultLike {
  id: string;
  passed: boolean;
  description: string;
}
export interface ValidationIssueLike {
  field: string;
  path: string;
  message: string;
}

export interface FieldMarks {
  /** Messages per top-level field: missing, uncertain, invalid, or evidence not found. */
  byField: Record<string, string[]>;
  /** Problems with the document as a whole (a scan that can't be verified, a failed category rule). */
  document: string[];
}

/** `invoice_number` → "Invoice number". */
export const humanize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replaceAll("_", " ");

/** A stored reason (`code` or `code:field`) in words a reviewer can act on. */
export interface ReasonText {
  /** What the queue filters by: `required_missing`. */
  code: string;
  /** The field or rule after the colon: `total`. */
  field?: string;
  /** Short, for a pill: "Missing: Total". */
  label: string;
  /** One or two sentences: what it means, and what to do. Empty for a code this doesn't know. */
  help: string;
}

type Words = readonly [label: string, help: string];

const REASON_WORDS: Record<GateCode | RouteReason | FailureReason, Words> = {
  // Gates: the extraction can't be trusted as it is.
  schema_invalid: ["Invalid value", "The value doesn't fit the field's type or format. Correct it before approving."],
  required_missing: ["Missing", "A required field is empty. Fill it in from the source, or reject the document."],
  uncertain: ["Uncertain", "The model marked this value uncertain. Check it against the source."],
  evidence_missing: ["No quote", "The model gave no quote from the source for this value, so it couldn't be checked."],
  evidence_not_found: [
    "Quote not in source",
    "The model's quote for this value isn't in the document. Check the value against the source.",
  ],
  evidence_unverifiable: [
    "Can't verify quotes",
    "Scanned or image content with no text to check quotes against. Check the values by eye.",
  ],
  rule_failed: ["Check failed", "One of the category's checks failed, such as line items not adding up to the total."],
  category_other: ["Unknown type", "Not one of your categories. Reclassify it, or reject it."],
  injection_suspected: [
    "Suspicious instructions",
    "The document contains text addressed to an AI system. It was treated as data, but look closely before approving.",
  ],
  sender_unauthenticated: [
    "Sender not verified",
    "The email failed its sender checks (SPF, DKIM, DMARC), so it may not be from who it says. Confirm the sender before approving.",
  ],
  // Routing: the extraction passed every gate, and a person still decides.
  below_threshold: ["Low confidence", "The model's confidence is below this category's auto-approval threshold."],
  no_score: ["No confidence score", "There's no confidence score to compare with a threshold, so a person decides."],
  automation_off: ["Always reviewed", "This category isn't set to auto-approve, so a person reviews every one."],
  reclassify_run: ["Reclassified", "A reviewer changed the category, and the new extraction comes back to a person."],
  audit_sample: [
    "Random audit",
    "This would have been auto-approved. It's held at random so you can see auto-approval stays accurate.",
  ],
  // Processing failures: no extraction to review. Retry once the cause is fixed.
  unsupported_file: ["Unsupported file", "This file type can't be read."],
  file_too_large: ["File too large", "The file is over the size limit (MAX_FILE_MB)."],
  too_many_pages: ["Too many pages", "The PDF has more pages than allowed (MAX_PDF_PAGES)."],
  parse_error: ["Couldn't read the file", "The file is damaged, encrypted or not what its type says."],
  parse_timeout: ["Reading timed out", "Reading the file took too long."],
  request_too_large: ["Too long for the model", "The document is longer than the model accepts."],
  llm_refusal: ["Model refused", "The model declined to answer."],
  llm_truncated: ["Answer cut off", "The model's answer hit its length limit."],
  llm_bad_request: [
    "Request rejected",
    "The model provider rejected the request. Check the model in Settings → Pipeline.",
  ],
  invalid_output: ["Unreadable answer", "The model's answer couldn't be parsed."],
  cassette_missing: [
    "No recorded answer",
    "Replay mode only has answers recorded for the sample documents. Process new ones with a live model (LLM_MODE=live and a key).",
  ],
  budget_exhausted: [
    "Budget used up",
    "Today's model budget for this workspace is spent. Raise it in Settings → General.",
  ],
  retries_exhausted: ["Failed after retries", "Processing kept failing. Check System health, then retry."],
  provider_unavailable: [
    "Provider unavailable",
    "The model provider kept refusing requests (rate limits or an outage). Retry later.",
  ],
  stalled: ["Stalled", "Processing stopped without finishing. Retry it."],
};

const SKIPPED_WORDS: Record<IntakeFilter, string> = {
  auto_replies: "auto-reply",
  bounces: "bounce",
  bulk: "bulk mail",
};

/** Words for a reason code alone (a filter), or a stored reason with its field (a pill). */
export function describeReason(reason: string): ReasonText {
  const colon = reason.indexOf(":");
  const code = colon < 0 ? reason : reason.slice(0, colon);
  const field = colon < 0 ? undefined : reason.slice(colon + 1) || undefined;
  if (code === "skipped") {
    const what = field ? (SKIPPED_WORDS[field as IntakeFilter] ?? humanize(field).toLowerCase()) : undefined;
    return {
      code,
      field,
      label: what ? `Skipped: ${what}` : "Skipped",
      help: "Filtered out at intake; never processed.",
    };
  }
  const words = (REASON_WORDS as Record<string, Words | undefined>)[code];
  if (!words) return { code, field, label: reason, help: "" };
  return { code, field, label: field ? `${words[0]}: ${humanize(field)}` : words[0], help: words[1] };
}

const FIELD_MESSAGES: Record<string, string> = {
  required_missing: "Required, but missing",
  uncertain: "The model marked this uncertain",
  evidence_missing: "No supporting quote",
  evidence_not_found: "Quote not found in the source",
};

/** Maps gate failures and validation issues onto form fields, for marking them in the review form. */
export function gateFieldMarks(input: {
  failures?: readonly GateFailureLike[];
  validationIssues?: readonly ValidationIssueLike[];
}): FieldMarks {
  const byField: Record<string, string[]> = {};
  const document: string[] = [];
  const mark = (field: string, message: string) => {
    const list = byField[field] ?? [];
    if (!list.includes(message)) list.push(message);
    byField[field] = list;
  };
  for (const f of input.failures ?? []) {
    if (f.code === "rule_failed") document.push(f.detail ?? `Rule ${f.field} failed`);
    else if (f.code === "evidence_unverifiable") document.push("Scanned or image content: evidence can't be verified");
    else if (f.code === "category_other") document.push("Not one of the configured categories");
    else if (f.code === "sender_unauthenticated") document.push(REASON_WORDS.sender_unauthenticated[1]);
    else if (f.code === "injection_suspected") {
      document.push(
        f.detail
          ? `The document contains text addressed to an AI system ("${f.detail}"). It was treated as data, but look closely before approving.`
          : REASON_WORDS.injection_suspected[1],
      );
    } else if (f.code === "schema_invalid") {
      const field = f.field || f.detail?.split("/")[1]?.split(" ")[0];
      if (field) mark(field, `Invalid: ${f.detail ?? "doesn't match the schema"}`);
      else document.push(`Invalid: ${f.detail ?? "doesn't match the schema"}`);
    } else if (f.field) mark(f.field, FIELD_MESSAGES[f.code] ?? f.code);
  }
  for (const issue of input.validationIssues ?? []) {
    // A refused approval reports a missing field this way; the gate already says it in words.
    const message =
      issue.message === "is required" && FIELD_MESSAGES.required_missing
        ? FIELD_MESSAGES.required_missing
        : `${issue.path || "/"} ${issue.message}`;
    if (issue.field) mark(issue.field, message);
    else document.push(message);
  }
  return { byField, document };
}
