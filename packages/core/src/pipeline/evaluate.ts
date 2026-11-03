import {
  evidenceFields,
  type JsonSchema,
  type RuleResult,
  requiredFields,
  runCategoryRules,
  type ValidationIssue,
  validateFields,
} from "@ai-triage/schemas";
import type { RunTrigger } from "../index";
import { type EvidencePart, type EvidenceResult, verifyEvidence } from "./evidence";
import { type GateFailure, gateReason, runGates } from "./gates";
import type { ExtractOutput } from "./outputs";
import { type RoutePolicy, type RouteResult, route } from "./route";
import { type EmailSender, findInjection, type SenderPolicy, senderPasses } from "./untrusted";

export interface EvaluateInput {
  category: string;
  /** Schema version row: its id keys the Ajv cache, its number selects the built-in rules. */
  schemaVersion: { id: string; version: number; jsonSchema: JsonSchema };
  output: ExtractOutput;
  parts: readonly EvidencePart[];
  score: number | null;
  policy: RoutePolicy;
  trigger: RunTrigger;
  auditDraw: number;
  ids: { documentId: string; extractionId: string };
  /** For email sources, the Authentication-Results headers (and the synced mailbox's provider); null for files. */
  sender: EmailSender | null;
  /** The config's sender policy (senderPolicy(config.policy)). */
  senderPolicy: SenderPolicy;
}

export interface Evaluation {
  validationIssues: ValidationIssue[];
  failures: GateFailure[];
  /** Stored in extractions.gate_results: failures, evidence checks (offsets for highlighting), rules. */
  gateResults: { failures: GateFailure[]; evidence: EvidenceResult; rules: RuleResult[] };
  route: RouteResult;
}

/**
 * Validation, rules, evidence, gates and routing for one extraction. Pure: the worker's route stage
 * and the phase 4 eval runner both call this, so evals measure exactly what production does.
 */
export function evaluateExtraction(input: EvaluateInput): Evaluation {
  const { jsonSchema } = input.schemaVersion;
  const { values, evidence: quotes, uncertain } = input.output;
  const validationIssues = validateFields(input.schemaVersion.id, jsonSchema, values);
  const rules = runCategoryRules(input.category, input.schemaVersion.version, values);
  const quoted = evidenceFields(jsonSchema).filter((f) => values[f] !== null && values[f] !== undefined);
  const evidence = verifyEvidence(input.parts, quotes, quoted);
  const failures = runGates({
    category: input.category,
    required: requiredFields(jsonSchema),
    values,
    uncertain,
    validationIssues,
    evidence,
    rules,
    injection: findInjection(input.parts.map((p) => p.text)),
    senderAuthenticated: senderPasses(input.sender, input.senderPolicy),
  });
  return {
    validationIssues,
    failures,
    gateResults: { failures, evidence, rules },
    route: route({
      gateReasons: failures.map(gateReason),
      score: input.score,
      policy: input.policy,
      trigger: input.trigger,
      auditDraw: input.auditDraw,
      action: { ...input.ids, category: input.category, values },
    }),
  };
}
