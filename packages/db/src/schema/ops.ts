import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Operational state shared by every worker. Global, not tenant tables: they describe the
// deployment (a model provider, a worker process), never a tenant's data.

/**
 * Backpressure (docs/architecture.md §5): a provider that answered 429, 529 or 503 cools down, and
 * every worker waits it out before calling that model again, instead of each burning its own retries.
 */
export const llmProviderState = pgTable(
  "llm_provider_state",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    /** Busy answers in a row; each one doubles the cooldown, up to its cap. A success resets it. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "llm_provider_state_pkey", columns: [t.provider, t.model] })],
);
