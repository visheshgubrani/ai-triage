import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { llmProviderState } from "./schema";

// Provider backpressure (docs/architecture.md §5), shared by every worker through Postgres.

/** The first busy answer cools a model down this long; each one in a row doubles it, up to the cap. */
export const COOLDOWN_BASE_MS = 5_000;
export const COOLDOWN_MAX_MS = 5 * 60_000;

export interface ProviderState {
  cooldownUntil: Date;
  consecutiveFailures: number;
}

export async function providerState(db: Db, provider: string, model: string): Promise<ProviderState | null> {
  const [row] = await db
    .select({
      cooldownUntil: llmProviderState.cooldownUntil,
      consecutiveFailures: llmProviderState.consecutiveFailures,
    })
    .from(llmProviderState)
    .where(and(eq(llmProviderState.provider, provider), eq(llmProviderState.model, model)));
  return row ?? null;
}

/**
 * Records a busy answer: the model cools down for the provider's Retry-After, or the doubling
 * backoff if that's longer. Atomic, so concurrent workers seeing the same 429 extend it once each.
 */
export async function tripCooldown(
  db: Db,
  input: { provider: string; model: string; retryAfterMs: number | null; reason: string; now: Date },
): Promise<Date> {
  const base = sql`least(${COOLDOWN_MAX_MS}, ${COOLDOWN_BASE_MS} * power(2, least(${llmProviderState.consecutiveFailures}, 16)))`;
  const retryAfter = Math.min(input.retryAfterMs ?? 0, COOLDOWN_MAX_MS);
  const first = new Date(input.now.getTime() + Math.max(retryAfter, COOLDOWN_BASE_MS));
  const [row] = await db
    .insert(llmProviderState)
    .values({
      provider: input.provider,
      model: input.model,
      cooldownUntil: first,
      reason: input.reason,
      consecutiveFailures: 1,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [llmProviderState.provider, llmProviderState.model],
      set: {
        cooldownUntil: sql`greatest(${llmProviderState.cooldownUntil}, ${input.now.toISOString()}::timestamptz + make_interval(secs => greatest(${retryAfter}, ${base}) / 1000.0))`,
        reason: input.reason,
        consecutiveFailures: sql`${llmProviderState.consecutiveFailures} + 1`,
        updatedAt: input.now,
      },
    })
    .returning({ cooldownUntil: llmProviderState.cooldownUntil });
  return row?.cooldownUntil ?? first;
}

/** A successful call: the model is healthy again. */
export async function clearCooldown(db: Db, provider: string, model: string): Promise<void> {
  await db
    .delete(llmProviderState)
    .where(and(eq(llmProviderState.provider, provider), eq(llmProviderState.model, model)));
}

/** Every cooldown that hasn't ended, for the System health page and metrics. */
export async function activeCooldowns(db: Db, now: Date) {
  return db
    .select()
    .from(llmProviderState)
    .where(sql`${llmProviderState.cooldownUntil} > ${now.toISOString()}::timestamptz`);
}
