import { type ModelInfo, modelInfo, type Provider, parseModelRef } from "@ai-triage/core";
import type { LlmContent, LlmRequest } from "@ai-triage/core/pipeline";
import type OpenAI from "openai";
import type { NormalizedResponse } from "./types";

// OpenAI, DeepSeek, OpenRouter and any OpenAI-compatible server (Ollama, vLLM, LM Studio) through
// the Chat Completions API. Same request shape everywhere; the differences are the token-limit
// param, how effort is passed, and whether the model takes a JSON Schema or only JSON mode.

export type OpenAiCompatibleProvider = Exclude<Provider, "anthropic">;

export type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  /** OpenRouter: unified reasoning control. */
  reasoning?: { effort: string };
  /** OpenRouter: only route to upstreams that honor every param (response_format above all). */
  provider?: { require_parameters: boolean };
};

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion & {
  /** DeepSeek reports cache hits under its own name too. */
  usage?: OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number };
};

function part(content: LlmContent): OpenAI.Chat.Completions.ChatCompletionContentPart {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "document":
      return {
        type: "file",
        file: { filename: content.title ?? "document.pdf", file_data: `data:${content.mime};base64,${content.data}` },
      };
    case "image":
      return { type: "image_url", image_url: { url: `data:${content.mime};base64,${content.data}` } };
  }
}

function effortParams(provider: OpenAiCompatibleProvider, request: LlmRequest, info: ModelInfo) {
  if (!info.efforts.includes(request.effort)) {
    throw new Error(`${request.model} doesn't accept effort "${request.effort}"`);
  }
  switch (provider) {
    case "openai":
    case "deepseek":
      return { reasoning_effort: request.effort };
    case "openrouter":
      return { reasoning: { effort: request.effort } };
    case "compat":
    case "sim":
      return {};
  }
}

/**
 * The exact Chat Completions params for a request. With `json_schema` the reduced schema is sent
 * strict (toApiSchema() already lists every key in `required` and closes every object); with
 * `json_object` the schema goes at the end of the system message. No sampling params.
 */
export function toChatParams(request: LlmRequest): ChatParams {
  const { provider, model } = parseModelRef(request.model);
  if (provider === "anthropic") throw new Error(`${request.model} is not an OpenAI-compatible model`);
  const info = modelInfo(request.model);
  const jsonMode = info.structuredOutput === "json_object";
  const system = jsonMode
    ? `${request.system}\n\nReply with a single json object that matches this JSON Schema:\n${JSON.stringify(request.outputSchema)}`
    : request.system;
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.content.map(part) },
    ],
    ...(provider === "openai" ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
    response_format: jsonMode
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: request.stage, strict: true, schema: request.outputSchema } },
    ...effortParams(provider, request, info),
    ...(provider === "openrouter" ? { provider: { require_parameters: true } } : {}),
  };
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

/**
 * A Chat Completions response in provider-neutral form. `prompt_tokens` includes cached tokens, so
 * the uncached input is the difference. A structured-output refusal comes back as `message.refusal`.
 */
export function normalizeChatCompletion(completion: ChatCompletion): NormalizedResponse {
  const choice = completion.choices?.[0];
  const finish = choice?.finish_reason ?? "unknown";
  const refused = Boolean(choice?.message?.refusal) || finish === "content_filter";
  const u = completion.usage;
  const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    stopReason: refused ? "refusal" : (STOP_REASONS[finish] ?? finish),
    refusalCategory: finish === "content_filter" ? "content_filter" : null,
    text: choice?.message?.content ?? null,
    usage: {
      input: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
      output: u?.completion_tokens ?? 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: cached,
    },
    hops: [],
    servedByFallback: false,
  };
}
