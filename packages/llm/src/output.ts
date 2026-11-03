import { PipelineError } from "@ai-triage/core/pipeline";
import { RefusalError, TruncatedError } from "./errors";
import { type NormalizedResponse, normalizeResponse } from "./providers";

/**
 * The structured output of a response. Checks the stop reason before reading content: a refusal or
 * truncation is an error, never a partial result.
 */
export function readOutput(response: NormalizedResponse, maxTokens: number): unknown {
  if (response.stopReason === "refusal") throw new RefusalError(response.refusalCategory);
  if (response.stopReason === "max_tokens") throw new TruncatedError(maxTokens);
  if (response.stopReason !== "end_turn") {
    throw new PipelineError("invalid_output", `unexpected stop reason ${response.stopReason}`);
  }
  if (response.text === null) throw new PipelineError("invalid_output", "the response has no text");
  try {
    return JSON.parse(response.text);
  } catch {
    throw new PipelineError("invalid_output", "the response is not valid JSON");
  }
}

/** The output of a stored attempt (an llm_calls row's model and raw response). */
export const readAttemptOutput = (model: string, response: unknown, maxTokens: number) =>
  readOutput(normalizeResponse(model, response), maxTokens);
