import type { PgBoss, Pool } from "@ai-triage/db";
import type { LlmGateway } from "@ai-triage/llm";
import type { Storage } from "@ai-triage/storage";
import type { SourceParseLimits } from "./source";

/** Everything the stage handlers touch. Tests swap the LLM transport, the clock and the audit draw. */
export interface PipelineDeps {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  llm: LlmGateway;
  limits: SourceParseLimits;
  /** Uniform [0, 1) draw per document and run; below a category's audit rate, an auto decision is audited. */
  auditDraw: (documentId: string, runId: string) => number;
  now: () => Date;
}
