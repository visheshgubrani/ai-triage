import { PipelineError } from "@ai-triage/core/pipeline";

/** Replay found no cassette for a request. Never falls back to a live call (invariant 8). */
export class CassetteMissError extends PipelineError {
  constructor(
    readonly hash: string,
    readonly stage: string,
  ) {
    super(
      "cassette_missing",
      `no cassette for ${stage} request ${hash}. Replay never calls Claude; record it with ` +
        "`LLM_MODE=record pnpm cassettes:record --yes` (needs ANTHROPIC_API_KEY and spends money).",
    );
    this.name = "CassetteMissError";
  }
}

export class RefusalError extends PipelineError {
  constructor(readonly category: string | null) {
    super("llm_refusal", `Claude declined the request${category ? ` (${category})` : ""}`);
    this.name = "RefusalError";
  }
}

export class TruncatedError extends PipelineError {
  constructor(maxTokens: number) {
    super("llm_truncated", `the response hit max_tokens (${maxTokens}) before finishing`);
    this.name = "TruncatedError";
  }
}

export class BudgetExhaustedError extends PipelineError {
  constructor(tenantId: string) {
    super("budget_exhausted", `tenant ${tenantId} has reached its daily LLM budget`);
    this.name = "BudgetExhaustedError";
  }
}
