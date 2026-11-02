import type { LlmContent, LlmRequest } from "@ai-triage/core/pipeline";
import type Anthropic from "@anthropic-ai/sdk";

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

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
