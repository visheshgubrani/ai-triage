import { type AutomationMode, EFFORTS, type Effort, isOneOf, MODEL_IDS, type ModelId } from "@ai-triage/core";
import { and, eq, isNull, max } from "drizzle-orm";
import { pipelineConfigCategories, pipelineConfigs, tenantSettings } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Pipeline configs are immutable versions (triggers in 0002_rls.sql). Changing anything means
// creating a new version; the tenant points at one active version through tenant_settings.

export interface StageConfig {
  model: ModelId;
  effort: Effort;
  promptVersionId: string;
}

export interface CategoryPolicy {
  category: string;
  schemaVersionId: string;
  threshold: number;
  automation?: AutomationMode;
  auditRate?: number;
}

export interface NewConfigVersion {
  name: string;
  parentId?: string;
  classify: StageConfig;
  extract: StageConfig;
  policy?: Record<string, unknown>;
  categories: CategoryPolicy[];
  createdBy?: string;
}

export type PipelineConfig = typeof pipelineConfigs.$inferSelect & {
  categories: (typeof pipelineConfigCategories.$inferSelect)[];
};

export class ConfigError extends Error {}

function assertStage(stage: string, { model, effort }: StageConfig) {
  if (!isOneOf(MODEL_IDS, model)) throw new ConfigError(`${stage}: unknown model "${model}"`);
  if (!isOneOf(EFFORTS, effort)) throw new ConfigError(`${stage}: unknown effort "${effort}"`);
}

/** Inserts the next config version (max + 1 for the tenant) with its category policies. */
export async function createConfigVersion(tx: TenantTx, input: NewConfigVersion): Promise<PipelineConfig> {
  assertStage("classify", input.classify);
  assertStage("extract", input.extract);
  if (input.categories.length === 0) throw new ConfigError("a config needs at least one category");

  const [latest] = await tx.db.select({ version: max(pipelineConfigs.version) }).from(pipelineConfigs);
  const [config] = await tx.db
    .insert(pipelineConfigs)
    .values({
      tenantId: tx.tenantId,
      version: (latest?.version ?? 0) + 1,
      parentId: input.parentId,
      name: input.name,
      classifyModel: input.classify.model,
      classifyEffort: input.classify.effort,
      classifyPromptVersionId: input.classify.promptVersionId,
      extractModel: input.extract.model,
      extractEffort: input.extract.effort,
      extractPromptVersionId: input.extract.promptVersionId,
      policy: input.policy ?? {},
      createdBy: input.createdBy,
    })
    .returning();
  if (!config) throw new ConfigError("config insert returned no row");

  const categories = await tx.db
    .insert(pipelineConfigCategories)
    .values(input.categories.map((c) => ({ tenantId: tx.tenantId, configId: config.id, ...c })))
    .returning();
  return { ...config, categories };
}

/** Freezes a config once it has been calibrated. Throws if it is missing or already frozen. */
export async function freezeConfig(tx: TenantTx, configId: string): Promise<Date> {
  const [row] = await tx.db
    .update(pipelineConfigs)
    .set({ frozenAt: new Date() })
    .where(and(eq(pipelineConfigs.id, configId), isNull(pipelineConfigs.frozenAt)))
    .returning({ frozenAt: pipelineConfigs.frozenAt });
  if (!row?.frozenAt) throw new ConfigError(`config ${configId} not found or already frozen`);
  return row.frozenAt;
}

export async function setActiveConfig(tx: TenantTx, configId: string): Promise<void> {
  await tx.db
    .insert(tenantSettings)
    .values({ tenantId: tx.tenantId, activeConfigId: configId })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { activeConfigId: configId } });
}

export async function getActiveConfig(tx: TenantTx): Promise<PipelineConfig | null> {
  const [settings] = await tx.db.select({ configId: tenantSettings.activeConfigId }).from(tenantSettings);
  if (!settings?.configId) return null;
  return getConfig(tx, settings.configId);
}

export async function getConfig(tx: TenantTx, configId: string): Promise<PipelineConfig | null> {
  const [config] = await tx.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.id, configId));
  if (!config) return null;
  const categories = await tx.db
    .select()
    .from(pipelineConfigCategories)
    .where(eq(pipelineConfigCategories.configId, configId));
  return { ...config, categories };
}
