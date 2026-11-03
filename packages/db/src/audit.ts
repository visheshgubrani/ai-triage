import type { AuditAction, AuditActorType } from "@ai-triage/core";
import { desc, sql } from "drizzle-orm";
import { auditEvents } from "./schema";
import type { TenantTx } from "./tenant-tx";

// The audit log (docs/security.md). Always called inside the tenant transaction that makes the
// change, so the change and its event commit or roll back together.

/** Who acted, and from where (the request context is null for the CLI and cron). */
export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  label: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditEventInput {
  action: AuditAction;
  target?: { type: string; id: string };
  /** Never secrets: URLs, ids, counts and the like. */
  details?: Record<string, unknown>;
}

export const SYSTEM_ACTOR = (label: string): AuditActor => ({ type: "system", id: null, label });

export async function recordAudit(tx: TenantTx, actor: AuditActor, event: AuditEventInput): Promise<void> {
  await tx.db.insert(auditEvents).values({
    tenantId: tx.tenantId,
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    action: event.action,
    targetType: event.target?.type ?? null,
    targetId: event.target?.id ?? null,
    details: event.details ?? {},
    ip: actor.ip ?? null,
    userAgent: actor.userAgent?.slice(0, 300) ?? null,
    requestId: actor.requestId ?? null,
  });
}

/**
 * Newest first, `limit` at a time. `cursor` comes from the previous page (`nextCursor`): the last
 * event's exact timestamp (microseconds, as text) and id, so events in the same millisecond aren't skipped.
 */
export async function listAuditEvents(tx: TenantTx, options: { cursor?: string; limit: number }) {
  const [at, id] = options.cursor?.split("|") ?? [];
  const rows = await tx.db
    .select({ event: auditEvents, at: sql<string>`${auditEvents.createdAt}::text` })
    .from(auditEvents)
    .where(
      at && id ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${at}::timestamptz, ${id}::uuid)` : undefined,
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(options.limit);
  const last = rows.at(-1);
  return {
    events: rows.map((r) => r.event),
    nextCursor: rows.length === options.limit && last ? `${last.at}|${last.event.id}` : null,
  };
}
