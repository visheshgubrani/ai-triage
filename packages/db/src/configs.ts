import { type AutomationMode, type Effort, isModelRef, type ModelRef, modelInfo } from "@ai-triage/core";
import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { pipelineConfigCategories, pipelineConfigs, promptVersions, tenantSettings } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Pipeline configs are immutable versions (triggers in 0002_rls.sql). Changing anything means
// creating a new version; the tenant points at one active version through tenant_settings.

export interface StageConfig {
  model: ModelRef;
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
  if (!isModelRef(model)) throw new ConfigError(`${stage}: unknown model "${model}"`);
  const { efforts } = modelInfo(model);
  if (!efforts.includes(effort)) {
    throw new ConfigError(`${stage}: ${model} accepts effort ${efforts.join(", ")}, not "${effort}"`);
  }
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

/** A category's routing settings in a candidate version. */
export interface CategoryChange {
  category: string;
  threshold: number;
  automation: AutomationMode;
  auditRate: number;
}

export interface CandidateConfig {
  /** The version this one starts from: everything not overridden is copied, `policy` verbatim. */
  parentId: string;
  name: string;
  classify?: Partial<StageConfig>;
  extract?: Partial<StageConfig>;
  /** Categories not listed keep the parent's settings. The category set and schema versions are the parent's. */
  categories?: CategoryChange[];
  /** Replaces the parent's sender policy (`policy.sender`, see senderPolicy() in core). */
  sender?: { require: boolean; trustedAuthServIds: string[] };
  createdBy?: string;
}

/** A new (unfrozen, inactive) version derived from another: the evals page's way to try a change. */
export async function createCandidateConfig(tx: TenantTx, input: CandidateConfig): Promise<PipelineConfig> {
  const parent = await getConfig(tx, input.parentId);
  if (!parent) throw new ConfigError(`config ${input.parentId} not found`);
  const unknown = (input.categories ?? []).filter((c) => !parent.categories.some((p) => p.category === c.category));
  if (unknown.length > 0) throw new ConfigError(`unknown categories: ${unknown.map((c) => c.category).join(", ")}`);
  return createConfigVersion(tx, {
    name: input.name,
    parentId: parent.id,
    classify: {
      model: input.classify?.model ?? (parent.classifyModel as ModelRef),
      effort: input.classify?.effort ?? (parent.classifyEffort as Effort),
      promptVersionId: input.classify?.promptVersionId ?? parent.classifyPromptVersionId,
    },
    extract: {
      model: input.extract?.model ?? (parent.extractModel as ModelRef),
      effort: input.extract?.effort ?? (parent.extractEffort as Effort),
      promptVersionId: input.extract?.promptVersionId ?? parent.extractPromptVersionId,
    },
    policy: {
      ...(parent.policy as Record<string, unknown>),
      ...(input.sender
        ? {
            sender: {
              ...input.sender,
              trustedAuthServIds: input.sender.trustedAuthServIds.map((s) => s.toLowerCase()),
            },
          }
        : {}),
    },
    categories: parent.categories.map((p) => {
      const change = input.categories?.find((c) => c.category === p.category);
      return {
        category: p.category,
        schemaVersionId: p.schemaVersionId,
        threshold: change?.threshold ?? Number(p.threshold),
        automation: change?.automation ?? p.automation,
        auditRate: change?.auditRate ?? Number(p.auditRate),
      };
    }),
    createdBy: input.createdBy,
  });
}

export interface ConfigListEntry extends PipelineConfig {
  active: boolean;
}

/** Every version, newest first, with its categories and whether it is the tenant's active one. */
export async function listConfigs(tx: TenantTx): Promise<ConfigListEntry[]> {
  const [settings] = await tx.db.select({ configId: tenantSettings.activeConfigId }).from(tenantSettings);
  const configs = await tx.db.select().from(pipelineConfigs).orderBy(desc(pipelineConfigs.version));
  const categories =
    configs.length === 0
      ? []
      : await tx.db
          .select()
          .from(pipelineConfigCategories)
          .where(
            inArray(
              pipelineConfigCategories.configId,
              configs.map((c) => c.id),
            ),
          )
          .orderBy(asc(pipelineConfigCategories.category));
  return configs.map((c) => ({
    ...c,
    categories: categories.filter((k) => k.configId === c.id),
    active: c.id === settings?.configId,
  }));
}

export async function listPromptVersions(tx: TenantTx) {
  return tx.db
    .select({
      id: promptVersions.id,
      stage: promptVersions.stage,
      version: promptVersions.version,
      createdAt: promptVersions.createdAt,
    })
    .from(promptVersions)
    .orderBy(asc(promptVersions.stage), desc(promptVersions.version));
}
