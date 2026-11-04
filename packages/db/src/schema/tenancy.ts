import type { IntakeFilters } from "@ai-triage/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, tenantId, tenantKey, updatedAt } from "./_helpers";
import { tenants, users } from "./auth";
import { pipelineConfigs } from "./pipeline";

/** Per-tenant settings. Webhook targets come only from here (docs/architecture.md §3). */
export const tenantSettings = pgTable(
  "tenant_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    activeConfigId: uuid("active_config_id"),
    webhookUrl: text("webhook_url"),
    /** Legacy plaintext column: `db:migrate` encrypts any value into webhook_secret_enc and clears it. */
    webhookSecret: text("webhook_secret"),
    /** The signing secret, encrypted (crypto.ts: AES-256-GCM, the tenant id as AAD). */
    webhookSecretEnc: text("webhook_secret_enc"),
    /** The secret before the last rotation, still signed with until `webhook_secret_prev_until`. */
    webhookSecretPrevEnc: text("webhook_secret_prev_enc"),
    webhookSecretPrevUntil: timestamp("webhook_secret_prev_until", { withTimezone: true }),
    dailyLlmCapUsd: numeric("daily_llm_cap_usd", { precision: 12, scale: 4 }).notNull().default("5"),
    /** Finished documents older than this many days are purged daily; null keeps them forever. */
    retentionDays: integer("retention_days"),
    /** Intake filters that are on, by name (core INTAKE_FILTERS); unset keys take DEFAULT_INTAKE_FILTERS. */
    intakeFilters: jsonb("intake_filters").$type<Partial<IntakeFilters>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "tenant_settings_active_config_fk",
      columns: [t.tenantId, t.activeConfigId],
      foreignColumns: [pipelineConfigs.tenantId, pipelineConfigs.id],
    }),
  ],
);

/** Postmark inbound address → tenant. Unique across tenants because it routes mail. */
export const inboundAddresses = pgTable(
  "inbound_addresses",
  {
    id: pk(),
    tenantId: tenantId(),
    address: text("address").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantKey("inbound_addresses", t),
    check("inbound_addresses_lowercase_check", sql`${t.address} = lower(${t.address})`),
  ],
);

/** Tenant API keys for the REST API and CLI. Only a hash is stored; `prefix` identifies a key in the UI. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Optional: the resolver refuses the key after this (0015_api_key_expiry.sql). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [tenantKey("api_keys", t)],
);

/** Two-step upload: the server issues `storage_key`; clients never choose one. */
export const uploads = pgTable(
  "uploads",
  {
    id: pk(),
    tenantId: tenantId(),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    expectedSize: bigint("expected_size", { mode: "number" }).notNull(),
    expectedMime: text("expected_mime").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [tenantKey("uploads", t)],
);

/** Daily LLM budget per tenant. Live calls reserve their worst case here before calling Claude. */
export const llmBudgetDays = pgTable(
  "llm_budget_days",
  {
    tenantId: tenantId(),
    day: date("day").notNull(),
    capUsd: numeric("cap_usd", { precision: 12, scale: 4 }).notNull(),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    reservedUsd: numeric("reserved_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    primaryKey({ name: "llm_budget_days_pkey", columns: [t.tenantId, t.day] }),
    check("llm_budget_days_non_negative_check", sql`${t.capUsd} >= 0 and ${t.spentUsd} >= 0 and ${t.reservedUsd} >= 0`),
  ],
);
