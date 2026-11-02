import type { FailureReason } from "../index";

/**
 * A failure that retrying can't fix (a bad file, a refusal, an oversized request...). The worker
 * fails the run at once with `reason` instead of letting pg-boss retry, and a human takes over.
 */
export class PipelineError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
