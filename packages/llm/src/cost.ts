import type { LlmRequest } from "@ai-triage/core/pipeline";
import { canonicalJson } from "./hash";
import type { Message } from "./transports";

/** USD per million tokens (a model_prices row). */
export interface Price {
  id: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWrite5mPerMtok: number;
  cacheWrite1hPerMtok: number;
  cacheReadPerMtok: number;
}

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/** Total prompt size (uncached + cache writes + cache reads), which selects the price tier. */
export const promptTokens = (u: UsageLike) =>
  u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** Σ(tokens × price) / 1e6 over input, output, 5m and 1h cache writes, and cache reads. */
export function computeCostUsd(usage: UsageLike, price: Price): number {
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = usage.cache_creation
    ? usage.cache_creation.ephemeral_5m_input_tokens
    : (usage.cache_creation_input_tokens ?? 0);
  const total =
    usage.input_tokens * price.inputPerMtok +
    usage.output_tokens * price.outputPerMtok +
    write5m * price.cacheWrite5mPerMtok +
    write1h * price.cacheWrite1hPerMtok +
    (usage.cache_read_input_tokens ?? 0) * price.cacheReadPerMtok;
  return total / 1e6;
}

export type FindPrice = (model: string, promptTokens: number) => Promise<Price | null>;

/**
 * Cost of a response. With server-side fallback, `usage.iterations` lists each hop with its model,
 * and each is priced at its own model's rate; an unpriced hop leaves the cost unknown (null).
 */
export async function messageCostUsd(message: Message, model: string, findPrice: FindPrice) {
  const hops = (message.usage.iterations ?? []) as unknown as (UsageLike & { model?: string | null })[];
  const price = await findPrice(model, promptTokens(message.usage));
  if (hops.length === 0)
    return { costUsd: price ? computeCostUsd(message.usage, price) : null, priceId: price?.id ?? null };
  let total = 0;
  for (const hop of hops) {
    const hopPrice = await findPrice(hop.model ?? model, promptTokens(hop));
    if (!hopPrice) return { costUsd: null, priceId: price?.id ?? null };
    total += computeCostUsd(hop, hopPrice);
  }
  return { costUsd: total, priceId: price?.id ?? null };
}

/** Rough token counts for the worst-case budget reservation. Over-estimating errs toward blocking. */
export const ESTIMATE = { bytesPerToken: 2.5, tokensPerPdfPage: 2000, tokensPerImage: 1600 };

export function estimatePromptTokens(request: LlmRequest): number {
  let bytes = Buffer.byteLength(request.system) + Buffer.byteLength(canonicalJson(request.outputSchema));
  let tokens = 0;
  for (const c of request.content) {
    if (c.type === "text") bytes += Buffer.byteLength(c.text);
    else if (c.type === "document") tokens += c.pages * ESTIMATE.tokensPerPdfPage;
    else tokens += ESTIMATE.tokensPerImage;
  }
  return Math.ceil(tokens + bytes / ESTIMATE.bytesPerToken);
}

/** Estimated prompt at the full input price plus `max_tokens` at the output price. */
export function estimateWorstCaseUsd(request: LlmRequest, price: Price): number {
  return (estimatePromptTokens(request) * price.inputPerMtok + request.maxTokens * price.outputPerMtok) / 1e6;
}
