import type { GateFailureLike, RuleResultLike } from "@ai-triage/core/review";

// The shape of `extractions.gate_results` (written by the pipeline's route stage, or by an edit).

export type EvidenceCheck =
  | { field: string; status: "verified"; partIndex: number; page: number | null; start: number; end: number }
  | { field: string; status: "missing" }
  | { field: string; status: "not_found"; quote: string; page: number | null };

export interface GateResults {
  failures?: GateFailureLike[];
  evidence?: { unverifiable: boolean; checks: EvidenceCheck[] } | null;
  rules?: RuleResultLike[];
}

export const gatesOf = (value: unknown): GateResults =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as GateResults) : {};

/** A JSON Schema node as the category templates produce it (the subset the form renders). */
export interface FieldSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  description?: string;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: string[];
  "x-evidence"?: boolean;
}

export const typeOf = (field: FieldSchema) =>
  Array.isArray(field.type) ? field.type.find((t) => t !== "null") : field.type;
