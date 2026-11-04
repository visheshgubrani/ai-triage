import type { LlmCallMode } from "@ai-triage/core";
import type { Pool } from "@ai-triage/db";
import type { LlmGateway } from "@ai-triage/llm";
import type { Storage } from "@ai-triage/storage";
import type { SourceParseLimits } from "../pipeline/source";

/**
 * Everything the eval runner touches. Deliberately no queue, no actions and no delivery: an eval run
 * can read storage and call the model, and it writes only eval results (invariant 7). A test pins
 * these keys, so adding a port here is a visible decision.
 */
export interface EvalDeps {
  pool: Pool;
  storage: Storage;
  llm: LlmGateway;
  limits: SourceParseLimits;
  /** How this worker's calls are stored (`record` calls the live API, so `live`). A run must match it. */
  llmMode: LlmCallMode;
  now: () => Date;
}
