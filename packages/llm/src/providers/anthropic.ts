import type { LlmContent, LlmRequest } from "@ai-triage/core/pipeline";
import type Anthropic from "@anthropic-ai/sdk";
import type { NormalizedResponse, Usage } from "./types";

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;

/** Server-side refusal fallback (opt-in by default). Not available on Haiku. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const supportsFallback = (model: string) => !model.startsWith("claude-haiku-");

function block(content: LlmContent): Anthropic.Beta.Messages.BetaContentBlockParam {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "document":
      return {
        type: "document",
        source: { type: "base64", media_type: content.mime, data: content.data },
        ...(content.title ? { title: content.title } : {}),
      };
    case "image":
      return { type: "image", source: { type: "base64", media_type: content.mime, data: content.data } };
  }
}

/**
 * The exact Messages API params for a request. Structured output via `output_config.format`; effort
 * set explicitly (Opus 5.5 and Haiku 5.5 default to medium); no sampling params, prefill or thinking
 * config (thinking can't be disabled on Opus 5.5). The system prompt is the cached prefix.
 */
export function toSdkParams(request: LlmRequest): MessageParams {
  if (request.effort === "none") throw new Error(`${request.model} has no "none" effort`);
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.content.map(block) }],
    output_config: {
      effort: request.effort,
      format: { type: "json_schema", schema: request.outputSchema },
    },
    ...(supportsFallback(request.model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

function usage(u: AnthropicUsage): Usage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheWrite5m: u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * A Messages API response in provider-neutral form. With server-side fallback, `usage.iterations`
 * lists each hop with its model, so each can be priced at its own rate.
 */
export function normalizeMessage(message: Message): NormalizedResponse {
  const iterations = (message.usage.iterations ?? []) as unknown as (AnthropicUsage & {
    type: string;
    model?: string | null;
  })[];
  const text = message.content.find((b) => b.type === "text");
  return {
    stopReason: message.stop_reason ?? "unknown",
    refusalCategory: message.stop_details?.category ?? null,
    text: text?.type === "text" ? text.text : null,
    usage: usage(message.usage),
    hops: iterations.map((it) => ({ ...usage(it), model: it.model ?? null })),
    servedByFallback: iterations.some((it) => it.type === "fallback_message"),
  };
}
