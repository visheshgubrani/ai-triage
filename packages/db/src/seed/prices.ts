import { sql } from "drizzle-orm";
import type { Db } from "../index";
import { modelPrices } from "../schema";

/** Date these prices were checked against https://platform.claude.com/docs/en/about-claude/pricing and the pages below. */
export const PRICES_VERIFIED_ON = "2026-11-03";

/**
 * USD per million tokens. Cache reads are 0.05x input on Opus 5.5 and Sonnet 5.5 (0.1x on Haiku);
 * Haiku 5.5 charges more once a prompt (including cache reads and writes) exceeds 100K tokens.
 * Batch is 0.5x on every model. Re-verify before changing, and add a new `effective_from` row
 * rather than editing history: llm_calls keep the price_id they were costed with.
 */
export const MODEL_PRICE_SEED = [
  { model: "claude-opus-5-5", promptTokensAbove: 0, input: "4", output: "20", w5m: "5", w1h: "8", read: "0.20" },
  { model: "claude-sonnet-5-5", promptTokensAbove: 0, input: "2", output: "10", w5m: "2.50", w1h: "4", read: "0.10" },
  {
    model: "claude-haiku-5-5",
    promptTokensAbove: 0,
    input: "0.10",
    output: "0.50",
    w5m: "0.125",
    w1h: "0.20",
    read: "0.01",
  },
  {
    model: "claude-haiku-5-5",
    promptTokensAbove: 100_000,
    input: "0.50",
    output: "2.50",
    w5m: "0.625",
    w1h: "1",
    read: "0.05",
  },
  // OpenAI-compatible providers bill no cache writes (write = input) and report cached prompt tokens.
  // https://developers.openai.com/api/docs/pricing
  { model: "openai:gpt-6.1-terra", promptTokensAbove: 0, input: "1", output: "5", w5m: "1", w1h: "1", read: "0.05" },
  // https://api-docs.deepseek.com/quick_start/pricing: peak-hour rates (off-peak is half), so the
  // recorded cost is an upper bound.
  {
    model: "deepseek:deepseek-flash",
    promptTokensAbove: 0,
    input: "0.30",
    output: "1.20",
    w5m: "0.30",
    w1h: "0.30",
    read: "0.006",
  },
  // OpenRouter routes to several upstreams at different prices: the highest listed, with no cache discount.
  {
    model: "openrouter:openai/gpt-6.1-terra",
    promptTokensAbove: 0,
    input: "2",
    output: "10",
    w5m: "2",
    w1h: "2",
    read: "2",
  },
  // A local OpenAI-compatible server costs nothing per token.
  { model: "compat:qwen3", promptTokensAbove: 0, input: "0", output: "0", w5m: "0", w1h: "0", read: "0" },
] as const;

/** Upserts the price list. Runs as the owner: the app role can only read model_prices. */
export async function seedPrices(ownerDb: Db): Promise<number> {
  const rows = MODEL_PRICE_SEED.map((p) => ({
    model: p.model,
    promptTokensAbove: p.promptTokensAbove,
    inputPerMtok: p.input,
    outputPerMtok: p.output,
    cacheWrite5mPerMtok: p.w5m,
    cacheWrite1hPerMtok: p.w1h,
    cacheReadPerMtok: p.read,
    batchMultiplier: "0.5",
    effectiveFrom: PRICES_VERIFIED_ON,
  }));
  await ownerDb
    .insert(modelPrices)
    .values(rows)
    .onConflictDoUpdate({
      target: [modelPrices.model, modelPrices.promptTokensAbove, modelPrices.effectiveFrom],
      set: {
        inputPerMtok: sql`excluded.input_per_mtok`,
        outputPerMtok: sql`excluded.output_per_mtok`,
        cacheWrite5mPerMtok: sql`excluded.cache_write_5m_per_mtok`,
        cacheWrite1hPerMtok: sql`excluded.cache_write_1h_per_mtok`,
        cacheReadPerMtok: sql`excluded.cache_read_per_mtok`,
        batchMultiplier: sql`excluded.batch_multiplier`,
      },
    });
  return rows.length;
}
