import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES } from "@ai-triage/core";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, oneOf, pk, tenantId, tenantKey } from "./_helpers";

/**
 * Security-relevant changes per tenant (docs/security.md): settings, keys, configs, redeliveries,
 * purges. Insert-only (trigger), and written in the same transaction as the change it records, so
 * a change and its event commit or roll back together. `details` never holds secrets.
 * `actor_id` has no FK: it is a user or an API key, and the event outlives either.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    tenantId: tenantId(),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: uuid("actor_id"),
    /** The actor as shown at the time (an email, a key prefix, a CLI name). */
    actorLabel: text("actor_label"),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("audit_events", t),
    oneOf("audit_events_actor_type_check", t.actorType, AUDIT_ACTOR_TYPES),
    oneOf("audit_events_action_check", t.action, AUDIT_ACTIONS),
    index("audit_events_created_idx").on(t.tenantId, t.createdAt),
  ],
);
