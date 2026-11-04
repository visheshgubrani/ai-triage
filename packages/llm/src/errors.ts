import { PipelineError } from "@ai-triage/core/pipeline";

/** Replay found no cassette for a request. Never falls back to a live call (invariant 8). */
export class CassetteMissError extends PipelineError {
  constructor(
    readonly hash: string,
    readonly stage: string,
  ) {
    super(
      "cassette_missing",
      `no cassette for ${stage} request ${hash}. Replay never calls a model; record it with ` +
        "`LLM_MODE=record pnpm cassettes:record --yes` (needs the provider's API key and spends money).",
    );
    this.name = "CassetteMissError";
  }
}

export class RefusalError extends PipelineError {
  constructor(readonly category: string | null) {
    super("llm_refusal", `the model declined the request${category ? ` (${category})` : ""}`);
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

/**
 * The provider answered 429, 529 (overloaded) or 503. Not a PipelineError: the job is retried, and
 * the gateway cools the model down for every worker (docs/architecture.md §5, backpressure).
 */
export class ProviderBusyError extends Error {
  constructor(
    readonly status: number,
    /** The provider's Retry-After, when it sent one. */
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(`provider busy (${status}): ${message}`);
    this.name = "ProviderBusyError";
  }
}

/** The model is cooling down after a busy answer, longer than a job waits: no call was made. */
export class ProviderCoolingDownError extends Error {
  constructor(
    readonly model: string,
    readonly until: Date,
  ) {
    super(`${model} is cooling down after the provider said it was busy, until ${until.toISOString()}`);
    this.name = "ProviderCoolingDownError";
  }
}
