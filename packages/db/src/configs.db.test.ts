import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  createCandidateConfig,
  createConfigVersion,
  freezeConfig,
  getActiveConfig,
  type NewConfigVersion,
  setActiveConfig,
} from "./configs";
import { createPool, withTenantTx } from "./index";
import { pipelineConfigCategories, pipelineConfigs } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { expectPgError, insertConfigFixture, newTenant, PG, testDbUrls } from "./testing";

// Pipeline configs are immutable versions; the only allowed change is freezing once.

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

let tenantId: string;
let input: NewConfigVersion;
beforeAll(async () => {
  tenantId = await newTenant(app);
  input = (await withTenantTx(app, tenantId, (tx) => insertConfigFixture(tx, ["invoice", "contract"]))).input;
});

const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantTx(app, tenantId, fn);

describe("pipeline configs", () => {
  it("numbers versions per tenant and stores the category policies", async () => {
    const first = await inTenant((tx) => createConfigVersion(tx, input));
    const second = await inTenant((tx) => createConfigVersion(tx, { ...input, parentId: first.id }));
    expect(second.version).toBe(first.version + 1);
    expect(second.categories.map((c) => [c.category, c.automation, c.auditRate])).toEqual([
      ["invoice", "review_all", 0.1],
      ["contract", "review_all", 0.1],
    ]);
    // A different tenant starts at 1.
    const other = await newTenant(app);
    const otherConfig = await withTenantTx(app, other, async (tx) =>
      createConfigVersion(tx, (await insertConfigFixture(tx)).input),
    );
    expect(otherConfig.version).toBe(1);
  });

  it("validates models and efforts", async () => {
    const badModel = { ...input, classify: { ...input.classify, model: "claude-opus-5-5-20260101" } };
    await expect(inTenant((tx) => createConfigVersion(tx, badModel as NewConfigVersion))).rejects.toThrow(ConfigError);
    // Each model accepts only the efforts it lists: Claude has no "none", DeepSeek Flash no "medium".
    const claudeNone = { ...input, classify: { ...input.classify, effort: "none" as const } };
    await expect(inTenant((tx) => createConfigVersion(tx, claudeNone))).rejects.toThrow(/accepts effort/);
    const deepseek = { ...input, extract: { ...input.extract, model: "deepseek:deepseek-flash" as const } };
    await expect(
      inTenant((tx) => createConfigVersion(tx, { ...deepseek, extract: { ...deepseek.extract, effort: "medium" } })),
    ).rejects.toThrow(ConfigError);
    const ok = await inTenant((tx) =>
      createConfigVersion(tx, { ...deepseek, extract: { ...deepseek.extract, effort: "high" } }),
    );
    expect(ok.extractModel).toBe("deepseek:deepseek-flash");
  });

  it("rejects edits and deletes", async () => {
    const config = await inTenant((tx) => createConfigVersion(tx, input));
    await expectPgError(
      inTenant(({ db }) =>
        db.update(pipelineConfigs).set({ classifyModel: "claude-haiku-5-5" }).where(eq(pipelineConfigs.id, config.id)),
      ),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(({ db }) => db.delete(pipelineConfigs).where(eq(pipelineConfigs.id, config.id))),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(({ db }) =>
        db
          .update(pipelineConfigCategories)
          .set({ threshold: 0.5 })
          .where(eq(pipelineConfigCategories.configId, config.id)),
      ),
      PG.integrityViolation,
    );
  });

  it("freezes exactly once, and a frozen config can't gain categories", async () => {
    const config = await inTenant((tx) => createConfigVersion(tx, input));
    await expect(inTenant((tx) => freezeConfig(tx, config.id))).resolves.toBeInstanceOf(Date);
    await expect(inTenant((tx) => freezeConfig(tx, config.id))).rejects.toThrow(ConfigError);
    await expectPgError(
      inTenant(({ db }) =>
        db.update(pipelineConfigs).set({ frozenAt: new Date() }).where(eq(pipelineConfigs.id, config.id)),
      ),
      PG.integrityViolation,
    );
    const [extra] = (await inTenant((tx) => insertConfigFixture(tx, ["support_request"]))).schemas;
    await expectPgError(
      inTenant(({ db }) =>
        db.insert(pipelineConfigCategories).values({
          tenantId,
          configId: config.id,
          category: "support_request",
          schemaVersionId: extra?.id ?? "",
          threshold: 0.9,
        }),
      ),
      PG.integrityViolation,
    );
  });

  it("rejects a category whose schema version belongs to another category", async () => {
    const [invoiceSchema] = input.categories;
    const mismatched = {
      ...input,
      categories: [{ category: "contract", schemaVersionId: invoiceSchema?.schemaVersionId ?? "", threshold: 0.9 }],
    };
    await expectPgError(
      inTenant((tx) => createConfigVersion(tx, mismatched)),
      PG.foreignKeyViolation,
    );
  });

  it("sets and reads the tenant's active config", async () => {
    expect(await inTenant((tx) => getActiveConfig(tx))).toBeNull();
    const config = await inTenant((tx) => createConfigVersion(tx, input));
    await inTenant((tx) => setActiveConfig(tx, config.id));
    const active = await inTenant((tx) => getActiveConfig(tx));
    expect(active?.id).toBe(config.id);
    expect(active?.categories).toHaveLength(2);
  });
});

describe("createCandidateConfig sender policy", () => {
  it("sets policy.sender on the candidate and leaves the parent's policy alone", async () => {
    const { input } = await inTenant((tx) => insertConfigFixture(tx));
    const parent = await inTenant((tx) => createConfigVersion(tx, input));
    const candidate = await inTenant((tx) =>
      createCandidateConfig(tx, {
        parentId: parent.id,
        name: "require sender auth",
        sender: { require: true, trustedAuthServIds: ["MX.Google.com"] },
      }),
    );
    expect(candidate.policy).toMatchObject({ sender: { require: true, trustedAuthServIds: ["mx.google.com"] } });
    expect((parent.policy as { sender?: unknown }).sender).toBeUndefined();
  });
});
