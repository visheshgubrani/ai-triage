import { and, desc, eq, lt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";
import { modelPrices } from "./schema";

export interface ModelPrice {
  id: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWrite5mPerMtok: number;
  cacheWrite1hPerMtok: number;
  cacheReadPerMtok: number;
}

/**
 * The price row for a call: the model's highest prompt-size tier that the prompt exceeds (0 =
 * flat pricing), with the latest `effective_from` on or before `on`. Seeded prices are dated by the
 * day they were verified, so a call dated earlier than every row of its tier uses the earliest row
 * rather than going unpriced. model_prices is global and read-only for the app role.
 */
export async function findModelPrice(
  db: NodePgDatabase<typeof schema>,
  model: string,
  promptTokens: number,
  on: Date = new Date(),
): Promise<ModelPrice | null> {
  const rows = await db
    .select()
    .from(modelPrices)
    .where(
      and(
        eq(modelPrices.model, model),
        or(eq(modelPrices.promptTokensAbove, 0), lt(modelPrices.promptTokensAbove, promptTokens)),
      ),
    )
    .orderBy(desc(modelPrices.promptTokensAbove), desc(modelPrices.effectiveFrom));
  const tier = rows.filter((r) => r.promptTokensAbove === rows[0]?.promptTokensAbove);
  const day = on.toISOString().slice(0, 10);
  const row = tier.find((r) => r.effectiveFrom <= day) ?? tier.at(-1);
  if (!row) return null;
  return {
    id: row.id,
    model: row.model,
    inputPerMtok: Number(row.inputPerMtok),
    outputPerMtok: Number(row.outputPerMtok),
    cacheWrite5mPerMtok: Number(row.cacheWrite5mPerMtok),
    cacheWrite1hPerMtok: Number(row.cacheWrite1hPerMtok),
    cacheReadPerMtok: Number(row.cacheReadPerMtok),
  };
}
