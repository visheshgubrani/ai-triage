import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

/**
 * One row per running worker process, refreshed every 15 seconds. The web warns when none is
 * recent ("documents won't be processed"), the most common setup mistake.
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  hostname: text("hostname").notNull(),
  version: text("version").notNull(),
  llmMode: text("llm_mode").notNull(),
  /**
   * What this worker can call: the providers it has keys for, whether the simulator is configured,
   * and the models replay has recordings of. Onboarding reads it to say whether a config can run.
   */
  capabilities: jsonb("capabilities")
    .$type<WorkerCapabilities>()
    .notNull()
    .default({ providers: [], simulator: false, recorded: [] }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});

export interface WorkerCapabilities {
  providers: string[];
  simulator: boolean;
  recorded: { model: string; effort: string }[];
}

/**
 * The first-run setup (docs/deploy.md): one row. While no tenant exists, the api keeps a fresh
 * one-time token here (its SHA-256 only) and logs the setup link; using it creates the first
 * workspace, after which setup is closed for good.
 */
export const installation = pgTable(
  "installation",
  {
    id: boolean("id").primaryKey().default(true),
    setupTokenHash: text("setup_token_hash"),
    setupTokenCreatedAt: timestamp("setup_token_created_at", { withTimezone: true }),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    setupTenantId: uuid("setup_tenant_id"),
  },
  (t) => [check("installation_single_row", sql`${t.id}`)],
);
