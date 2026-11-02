import { date, integer, numeric, pgTable, text, unique } from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_helpers";

/**
 * Global model price list, USD per million tokens. A row applies from `effective_from` to prompts
 * longer than `prompt_tokens_above` (0 for flat pricing; Haiku 5.5 has a >100K-token tier).
 * Cost is computed when an llm_calls row is written and stored with its `price_id`.
 * Read-only for the app role.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: pk(),
    model: text("model").notNull(),
    promptTokensAbove: integer("prompt_tokens_above").notNull().default(0),
    inputPerMtok: numeric("input_per_mtok", { precision: 10, scale: 4 }).notNull(),
    outputPerMtok: numeric("output_per_mtok", { precision: 10, scale: 4 }).notNull(),
    cacheWrite5mPerMtok: numeric("cache_write_5m_per_mtok", { precision: 10, scale: 4 }).notNull(),
    cacheWrite1hPerMtok: numeric("cache_write_1h_per_mtok", { precision: 10, scale: 4 }).notNull(),
    cacheReadPerMtok: numeric("cache_read_per_mtok", { precision: 10, scale: 4 }).notNull(),
    batchMultiplier: numeric("batch_multiplier", { precision: 4, scale: 3 }).notNull().default("0.5"),
    effectiveFrom: date("effective_from").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("model_prices_model_tier_effective_key").on(t.model, t.promptTokensAbove, t.effectiveFrom)],
);
