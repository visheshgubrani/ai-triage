import type { Effort, EvidenceMode, LlmStage, ModelId, PartKind } from "../index";

/** One parsed part of a document, as stored in document_parts (partIndex is its position). */
export interface ParsedPart {
  partIndex: number;
  kind: PartKind;
  mime: string;
  /** Attachment or file name. */
  label: string | null;
  /** 1-based PDF page; null for other parts. */
  page: number | null;
  text: string;
  evidenceMode: EvidenceMode;
  /** The part's binary in storage (PDFs and images are sent to Claude as such). */
  storageKey: string | null;
}

/** A provider-neutral Claude request. packages/llm turns it into SDK params and hashes those. */
export interface LlmRequest {
  stage: LlmStage;
  model: ModelId;
  effort: Effort;
  maxTokens: number;
  /** Cached prefix: instructions, category definitions, examples. */
  system: string;
  content: LlmContent[];
  /** Already reduced with toApiSchema(). */
  outputSchema: Record<string, unknown>;
}

export type LlmContent =
  | { type: "text"; text: string }
  /** `pages` feeds the budget estimate only; it isn't sent. */
  | { type: "document"; mime: "application/pdf"; data: string; title: string | null; pages: number }
  | { type: "image"; mime: "image/png" | "image/jpeg"; data: string };

export interface StageModel {
  model: ModelId;
  effort: Effort;
  maxTokens: number;
}
