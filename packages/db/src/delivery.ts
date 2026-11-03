import { QUEUES } from "@ai-triage/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { enqueue, type PgBoss } from "./boss";
import { actions, documents, extractions, tenantSettings } from "./schema";
import type { TenantTx } from "./tenant-tx";

// The actions outbox (docs/architecture.md §5): delivery reads an action and the tenant's webhook
// target, posts with no transaction open, then records the outcome. Every write is guarded on the
// action still being `pending`, and keeps documents.delivery_status in step.

export type ActionRow = typeof actions.$inferSelect;

/** The action and where to send it, or null if the action isn't visible. */
export async function loadDelivery(tx: TenantTx, actionId: string) {
  const [action] = await tx.db.select().from(actions).where(eq(actions.id, actionId));
  if (!action) return null;
  const [settings] = await tx.db
    .select({ url: tenantSettings.webhookUrl, secret: tenantSettings.webhookSecret })
    .from(tenantSettings);
  return { action, url: settings?.url ?? null, secret: settings?.secret ?? null };
}

/** Counts a failed attempt that will be retried. */
export async function recordAttempt(tx: TenantTx, input: { actionId: string; error: string }): Promise<void> {
  await tx.db
    .update(actions)
    .set({ attempts: sql`${actions.attempts} + 1`, lastError: input.error.slice(0, 1000) })
    .where(and(eq(actions.id, input.actionId), eq(actions.status, "pending")));
}

export async function markDelivered(tx: TenantTx, input: { actionId: string; at: Date }): Promise<boolean> {
  const [row] = await tx.db
    .update(actions)
    .set({ status: "delivered", attempts: sql`${actions.attempts} + 1`, lastError: null, deliveredAt: input.at })
    .where(and(eq(actions.id, input.actionId), eq(actions.status, "pending")))
    .returning({ documentId: actions.documentId });
  if (!row) return false;
  await tx.db.update(documents).set({ deliveryStatus: "delivered" }).where(eq(documents.id, row.documentId));
  return true;
}

/**
 * Gives up on an action: a permanent failure (`countAttempt`), or retries exhausted (the dead-letter
 * handler, whose last attempt was already counted). The document shows under "Delivery failures".
 */
export async function markDeliveryFailed(
  tx: TenantTx,
  input: { actionId: string; error: string; countAttempt: boolean },
): Promise<boolean> {
  const [row] = await tx.db
    .update(actions)
    .set({
      status: "failed",
      lastError: input.error.slice(0, 1000),
      ...(input.countAttempt ? { attempts: sql`${actions.attempts} + 1` } : {}),
    })
    .where(and(eq(actions.id, input.actionId), eq(actions.status, "pending")))
    .returning({ documentId: actions.documentId });
  if (!row) return false;
  await tx.db.update(documents).set({ deliveryStatus: "failed" }).where(eq(documents.id, row.documentId));
  return true;
}

/** Failed actions, most recent first, for the "Delivery failures" view. */
export async function listDeliveryFailures(tx: TenantTx, limit = 100) {
  return tx.db
    .select({
      actionId: actions.id,
      documentId: actions.documentId,
      title: documents.title,
      category: extractions.category,
      attempts: actions.attempts,
      lastError: actions.lastError,
      createdAt: actions.createdAt,
      updatedAt: actions.updatedAt,
    })
    .from(actions)
    .innerJoin(documents, eq(documents.id, actions.documentId))
    .innerJoin(extractions, eq(extractions.id, actions.extractionId))
    .where(eq(actions.status, "failed"))
    .orderBy(desc(actions.updatedAt))
    .limit(limit);
}

/**
 * Redeliver: puts a failed (or already delivered) action back in the outbox. The job gets a fresh id,
 * since the original job's id would dedup, but the Idempotency-Key stays the action id, so a receiver
 * that already processed it can tell. Returns false when the action isn't failed or delivered.
 */
export async function requeueAction(tx: TenantTx, boss: PgBoss, actionId: string): Promise<boolean> {
  const [row] = await tx.db
    .update(actions)
    .set({ status: "pending", lastError: null })
    .where(and(eq(actions.id, actionId), inArray(actions.status, ["failed", "delivered"])))
    .returning({ documentId: actions.documentId });
  if (!row) return false;
  await tx.db.update(documents).set({ deliveryStatus: "pending" }).where(eq(documents.id, row.documentId));
  await enqueue(boss, tx, QUEUES.deliver, { tenantId: tx.tenantId, actionId });
  return true;
}
