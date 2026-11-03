import type { LlmRequest } from "@ai-triage/core/pipeline";
import { canonicalJson } from "./hash";
import type { NormalizedResponse, Usage } from "./providers";

/** USD per million tokens (a model_prices row). */
export interface Price {
  id: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWrite5mPerMtok: number;
  cacheWrite1hPerMtok: number;
  cacheReadPerMtok: number;
}

/** Total prompt size (uncached + cache writes + cache reads), which selects the price tier. */
export const promptTokens = (u: Usage) => u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;

/** Σ(tokens × price) / 1e6 over input, output, 5m and 1h cache writes, and cache reads. */
export function computeCostUsd(usage: Usage, price: Price): number {
  const total =
    usage.input * price.inputPerMtok +
    usage.output * price.outputPerMtok +
    usage.cacheWrite5m * price.cacheWrite5mPerMtok +
    usage.cacheWrite1h * price.cacheWrite1hPerMtok +
    usage.cacheRead * price.cacheReadPerMtok;
  return total / 1e6;
}

export type FindPrice = (model: string, promptTokens: number) => Promise<Price | null>;

/**
 * Cost of a response. With server-side fallback, each hop is priced at its own model's rate; an
 * unpriced hop leaves the cost unknown (null).
 */
export async function responseCostUsd(response: NormalizedResponse, model: string, findPrice: FindPrice) {
  const price = await findPrice(model, promptTokens(response.usage));
  if (response.hops.length === 0)
    return { costUsd: price ? computeCostUsd(response.usage, price) : null, priceId: price?.id ?? null };
  let total = 0;
  for (const hop of response.hops) {
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
