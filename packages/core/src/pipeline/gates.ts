import type { FieldValues, RuleResult, ValidationIssue } from "@ai-triage/schemas";
import { type GateCode, OTHER_CATEGORY } from "../index";
import type { EvidenceResult } from "./evidence";

/** A failed gate. Any failure sends the document to review (docs/architecture.md §6). */
export interface GateFailure {
  code: GateCode;
  field?: string;
  detail?: string;
}

/** The reason string stored in decision_reasons and on review tasks: `code` or `code:field`. */
export const gateReason = (f: GateFailure) => (f.field ? `${f.code}:${f.field}` : f.code);

export interface GateInput {
  category: string;
  required: readonly string[];
  values: FieldValues;
  uncertain: readonly string[];
  validationIssues: readonly ValidationIssue[];
  evidence: EvidenceResult;
  rules: readonly RuleResult[];
  /** A phrase in the document that addresses the triage system (findInjection), or null. */
  injection: string | null;
  /** False only for email the config requires to be authenticated and that isn't. */
  senderAuthenticated: boolean;
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export function runGates(input: GateInput): GateFailure[] {
  if (input.category === OTHER_CATEGORY) return [{ code: "category_other" }];
  const failures: GateFailure[] = [];
  if (input.injection) failures.push({ code: "injection_suspected", detail: input.injection });
  if (!input.senderAuthenticated) failures.push({ code: "sender_unauthenticated" });

  const invalid = new Map<string, string>();
  for (const issue of input.validationIssues) {
    if (!invalid.has(issue.field)) invalid.set(issue.field, `${issue.path || "/"} ${issue.message}`);
  }
  for (const [field, detail] of invalid) failures.push({ code: "schema_invalid", ...(field ? { field } : {}), detail });

  for (const field of input.required) {
    if (isEmpty(input.values[field])) failures.push({ code: "required_missing", field });
  }
  for (const field of input.uncertain) failures.push({ code: "uncertain", field });

  if (input.evidence.unverifiable) failures.push({ code: "evidence_unverifiable" });
  for (const check of input.evidence.checks) {
    if (check.status === "missing") failures.push({ code: "evidence_missing", field: check.field });
    if (check.status === "not_found")
      failures.push({ code: "evidence_not_found", field: check.field, detail: check.quote });
  }

  for (const rule of input.rules) {
    if (!rule.passed) failures.push({ code: "rule_failed", field: rule.id, detail: rule.description });
  }
  return failures;
}
