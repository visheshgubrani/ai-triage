import { PipelineError } from "@ai-triage/core/pipeline";
import { RefusalError, TruncatedError } from "./errors";
import type { Message } from "./transports";

/** True when a fallback model served the response (server-side fallback after a refusal). */
export const servedByFallback = (message: Message) =>
  (message.usage.iterations ?? []).some((it) => it.type === "fallback_message");

/**
 * The structured output of a response. Checks `stop_reason` before reading content: a refusal or
 * truncation is an error, never a partial result.
 */
export function readOutput(message: Message, maxTokens: number): unknown {
  if (message.stop_reason === "refusal") throw new RefusalError(message.stop_details?.category ?? null);
  if (message.stop_reason === "max_tokens") throw new TruncatedError(maxTokens);
  if (message.stop_reason !== "end_turn") {
    throw new PipelineError("invalid_output", `unexpected stop_reason ${message.stop_reason}`);
  }
  const text = message.content.find((b) => b.type === "text");
  if (text?.type !== "text") throw new PipelineError("invalid_output", "the response has no text block");
  try {
    return JSON.parse(text.text);
  } catch {
    throw new PipelineError("invalid_output", "the response is not valid JSON");
  }
}
