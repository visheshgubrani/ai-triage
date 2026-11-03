import {
  type FieldValues,
  type JsonSchema,
  type RuleResult,
  requiredFields,
  runCategoryRules,
  type ValidationIssue,
  validateFields,
} from "@ai-triage/schemas";
import type { EvidenceResult } from "./evidence";
import { type GateFailure, runGates } from "./gates";

/** `extractions.gate_results`. A reviewer's revision has no evidence of its own, so `evidence` is null. */
export interface RevisionGateResults {
  failures: GateFailure[];
  evidence: EvidenceResult | null;
  rules: RuleResult[];
}

export interface RevisionCheck {
  /** Ajv issues against the full schema. Any issue blocks the approval: the payload must match the schema. */
  validationIssues: ValidationIssue[];
  gateResults: RevisionGateResults;
}

/**
 * Checks a reviewer's edited values before they become a revision. Schema validity is required;
 * category rules (say, line items adding up) are only recorded, since a human may knowingly approve
 * an invoice with a discount line the model left out.
 */
export function checkUserRevision(input: {
  category: string;
  schemaVersion: { id: string; version: number; jsonSchema: JsonSchema };
  values: FieldValues;
}): RevisionCheck {
  const { jsonSchema } = input.schemaVersion;
  const validationIssues = validateFields(input.schemaVersion.id, jsonSchema, input.values);
  const rules = runCategoryRules(input.category, input.schemaVersion.version, input.values);
  const failures = runGates({
    category: input.category,
    required: requiredFields(jsonSchema),
    values: input.values,
    uncertain: [],
    validationIssues,
    evidence: { unverifiable: false, checks: [] },
    rules,
  });
  return { validationIssues, gateResults: { failures, evidence: null, rules } };
}
