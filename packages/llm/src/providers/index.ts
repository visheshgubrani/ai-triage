import { parseModelRef } from "@ai-triage/core";
import type { LlmRequest } from "@ai-triage/core/pipeline";
import { type Message, type MessageParams, normalizeMessage, toSdkParams } from "./anthropic";
import {
  type ChatCompletion,
  type ChatParams,
  normalizeChatCompletion,
  type OpenAiCompatibleProvider,
  toChatParams,
} from "./openai-compatible";
import type { NormalizedResponse } from "./types";

export * from "./anthropic";
export * from "./openai-compatible";
export * from "./types";

/** What goes over the wire: the provider and its exact params. Cassettes are keyed by its hash. */
export type WireRequest =
  | { provider: "anthropic"; params: MessageParams }
  | { provider: OpenAiCompatibleProvider; params: ChatParams };

export function toWireRequest(request: LlmRequest): WireRequest {
  const { provider } = parseModelRef(request.model);
  return provider === "anthropic"
    ? { provider, params: toSdkParams(request) }
    : { provider, params: toChatParams(request) };
}

/** A raw response (live, replayed or stored in llm_calls) of `model`, in provider-neutral form. */
export function normalizeResponse(model: string, raw: unknown): NormalizedResponse {
  return parseModelRef(model).provider === "anthropic"
    ? normalizeMessage(raw as Message)
    : normalizeChatCompletion(raw as ChatCompletion);
}
