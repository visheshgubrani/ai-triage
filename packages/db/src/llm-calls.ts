import type { LlmCallContext, LlmCallMode, LlmStage } from "@ai-triage/core";
import { and, desc, eq, isNotNull, isNull, max, type SQL } from "drizzle-orm";
import type pg from "pg";
import { PG, pgCode } from "./errors";
import { llmCalls } from "./schema";
import { type TenantTx, withTenantTx } from "./tenant-tx";

// One llm_calls row per Claude attempt (invariant 4). An attempt is saved in its own small
// transaction as soon as the response arrives, reused on retry, and marked canonical when its
// stage commits. Each row has exactly one execution context: a processing run, or an eval run + item.

export type { LlmCallContext };

export type LlmCallRow = typeof llmCalls.$inferSelect;

export interface NewLlmAttempt {
  stage: LlmStage;
  mode: LlmCallMode;
  model: string;
  effort: string;
  requestHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number | null;
  priceId: string | null;
  latencyMs: number | null;
  stopReason: string | null;
  servedByFallback: boolean;
  requestId: string | null;
  response: unknown;
  error: string | null;
}

function inContext(ctx: LlmCallContext): SQL | undefined {
  return "runId" in ctx
    ? eq(llmCalls.processingRunId, ctx.runId)
    : and(eq(llmCalls.evalRunId, ctx.evalRunId), eq(llmCalls.evalItemId, ctx.evalItemId));
}

function contextColumns(ctx: LlmCallContext) {
  return "runId" in ctx ? { processingRunId: ctx.runId } : { evalRunId: ctx.evalRunId, evalItemId: ctx.evalItemId };
}

/** The latest successful attempt (a response and no error) for this context and stage, if any. */
export async function findReusableAttempt(
  tx: TenantTx,
  ctx: LlmCallContext,
  stage: LlmStage,
): Promise<LlmCallRow | null> {
  const [row] = await tx.db
    .select()
    .from(llmCalls)
    .where(and(inContext(ctx), eq(llmCalls.stage, stage), isNotNull(llmCalls.response), isNull(llmCalls.error)))
    .orderBy(desc(llmCalls.attempt))
    .limit(1);
  return row ?? null;
}

/**
 * Saves an attempt in its own transaction, numbered max + 1 for its context and stage. Two
 * workers racing on the same stage collide on the unique (context, stage, attempt) key; the loser
 * retries with the next number, so a paid-for response is never dropped.
 */
export async function insertAttempt(
  pool: pg.Pool,
  tenantId: string,
  ctx: LlmCallContext,
  attempt: NewLlmAttempt,
): Promise<LlmCallRow> {
  for (let tries = 1; ; tries++) {
    try {
      return await withTenantTx(pool, tenantId, async ({ db }) => {
        const [latest] = await db
          .select({ n: max(llmCalls.attempt) })
          .from(llmCalls)
          .where(and(inContext(ctx), eq(llmCalls.stage, attempt.stage)));
        const [row] = await db
          .insert(llmCalls)
          .values({
            tenantId,
            ...contextColumns(ctx),
            ...attempt,
            attempt: (latest?.n ?? 0) + 1,
            costUsd: attempt.costUsd === null ? null : attempt.costUsd.toFixed(6),
          })
          .returning();
        if (!row) throw new Error("llm_calls insert returned no row");
        return row;
      });
    } catch (err) {
      if (pgCode(err) !== PG.uniqueViolation || tries >= 5) throw err;
    }
  }
}

/** Marks the attempt a stage committed with as canonical. Call inside the stage's commit transaction. */
export async function markCanonical(
  tx: TenantTx,
  input: { id: string; ctx: LlmCallContext; stage: LlmStage },
): Promise<boolean> {
  const rows = await tx.db
    .update(llmCalls)
    .set({ canonical: true })
    .where(and(eq(llmCalls.id, input.id), inContext(input.ctx), eq(llmCalls.stage, input.stage)))
    .returning({ id: llmCalls.id });
  return rows.length === 1;
}

/** The attempt a committed stage used (its canonical row), or null. */
export async function loadCanonicalAttempt(
  tx: TenantTx,
  ctx: LlmCallContext,
  stage: LlmStage,
): Promise<LlmCallRow | null> {
  const [row] = await tx.db
    .select()
    .from(llmCalls)
    .where(and(inContext(ctx), eq(llmCalls.stage, stage), eq(llmCalls.canonical, true)));
  return row ?? null;
}
