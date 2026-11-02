import { createHash } from "node:crypto";
import { dropNulls, type FieldValues } from "@ai-triage/schemas";
import type { AutomationMode, Decision, RouteReason, RunTrigger } from "../index";

export interface RoutePolicy {
  threshold: number;
  automation: AutomationMode;
  auditRate: number;
}

/** What an approval would send. Production freezes it into `actions.payload`; evals only store it. */
export interface ProposedAction {
  type: "webhook";
  event: "document.approved";
  document_id: string;
  extraction_id: string;
  category: string;
  fields: FieldValues;
}

export interface RouteInput {
  /** Reasons of failed gates (`code` or `code:field`). */
  gateReasons: readonly string[];
  /** The classification's self_confidence; null when the run had no classification (reclassify). */
  score: number | null;
  policy: RoutePolicy;
  trigger: RunTrigger;
  /** Uniform in [0, 1): an auto decision is held for audit when it falls below `auditRate`. */
  auditDraw: number;
  action: { documentId: string; extractionId: string; category: string; values: FieldValues };
}

export interface RouteResult {
  decision: Decision;
  /** An auto decision held for review as an `audit` task. */
  audit: boolean;
  reasons: string[];
  proposedAction: ProposedAction;
}

/**
 * Pure routing (docs/architecture.md §6): auto only if every gate passed, the score clears the
 * category threshold, the category opted into automation, and the run wasn't a reclassify.
 */
export function route(input: RouteInput): RouteResult {
  const reasons: string[] = [...input.gateReasons];
  const add = (r: RouteReason) => reasons.push(r);
  if (input.trigger === "reclassify") add("reclassify_run");
  if (input.score === null) add("no_score");
  else if (input.score < input.policy.threshold) add("below_threshold");
  if (input.policy.automation !== "auto_when_confident") add("automation_off");

  const proposedAction: ProposedAction = {
    type: "webhook",
    event: "document.approved",
    document_id: input.action.documentId,
    extraction_id: input.action.extractionId,
    category: input.action.category,
    fields: dropNulls(input.action.values),
  };
  if (reasons.length > 0) return { decision: "review", audit: false, reasons, proposedAction };
  if (input.auditDraw < input.policy.auditRate) {
    return { decision: "auto", audit: true, reasons: ["audit_sample"], proposedAction };
  }
  return { decision: "auto", audit: false, reasons: [], proposedAction };
}

/** The default audit draw: a uniform value fixed per document and run. */
export function auditDraw(documentId: string, runId: string): number {
  const digest = createHash("sha256").update(`audit:${documentId}:${runId}`).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}
