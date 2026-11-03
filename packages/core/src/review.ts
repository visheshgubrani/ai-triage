// @ai-triage/core/review: pure helpers for the review queue, shared by the api and the web app.
// No imports beyond the closed sets, so it is safe in the browser.

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
    else if (f.code === "schema_invalid") {
      const field = f.field || f.detail?.split("/")[1]?.split(" ")[0];
      if (field) mark(field, `Invalid: ${f.detail ?? "doesn't match the schema"}`);
      else document.push(`Invalid: ${f.detail ?? "doesn't match the schema"}`);
    } else if (f.field) mark(f.field, FIELD_MESSAGES[f.code] ?? f.code);
  }
  for (const issue of input.validationIssues ?? []) {
    const message = `${issue.path || "/"} ${issue.message}`;
    if (issue.field) mark(issue.field, message);
    else document.push(message);
  }
  return { byField, document };
}
