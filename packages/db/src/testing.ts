import { randomUUID } from "node:crypto";
import type pg from "pg";
import { inject } from "vitest";
import type { NewConfigVersion } from "./configs";
import { PG, pgCode } from "./errors";
import type { MigrationUrls } from "./migrate";
import { categorySchemaVersions, documents, promptVersions } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { createTenant } from "./tenants";

// Test-only helpers for *.db.test.ts files (exported as @ai-triage/db/testing; never imported by app code).

export { PG, pgCode };

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: MigrationUrls;
  }
}

/** URLs of the scratch `triage_test` database created by packages/db/test/global-setup.ts. */
export function testDbUrls(): MigrationUrls {
  return inject("dbUrls");
}

/** A fresh tenant with a unique slug, so test files never share rows. */
export async function newTenant(pool: pg.Pool): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const { id } = await createTenant(pool, { name: `Test ${suffix}`, slug: `test-${suffix}` });
  return id;
}

/** Awaits `promise`, expecting it to fail with the given SQLSTATE; returns the error. */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    const actual = pgCode(err);
    if (actual !== code) throw new Error(`expected SQLSTATE ${code}, got ${actual ?? "none"}: ${String(err)}`);
    return err;
  }
  throw new Error(`expected SQLSTATE ${code}, but the query succeeded`);
}

/**
 * Inserts prompt versions and one schema version per category for the tenant in `tx`, and returns
 * a config input using them (Opus 5.5 at low effort, review_all). Versions are numbered per call
 * so a test can create several fixtures in one tenant.
 */
export async function insertConfigFixture(tx: TenantTx, categories: string[] = ["invoice"]) {
  const version = Math.floor(Math.random() * 1_000_000);
  const [classifyPrompt, extractPrompt] = await tx.db
    .insert(promptVersions)
    .values([
      { tenantId: tx.tenantId, stage: "classify", version, body: "Classify." },
      { tenantId: tx.tenantId, stage: "extract", version, body: "Extract." },
    ])
    .returning();
  const schemas = await tx.db
    .insert(categorySchemaVersions)
    .values(categories.map((category) => ({ tenantId: tx.tenantId, category, version, jsonSchema: {} })))
    .returning();
  if (!classifyPrompt || !extractPrompt) throw new Error("fixture insert failed");
  const input: NewConfigVersion = {
    name: "test config",
    classify: { model: "claude-opus-5-5", effort: "low", promptVersionId: classifyPrompt.id },
    extract: { model: "claude-opus-5-5", effort: "low", promptVersionId: extractPrompt.id },
    categories: schemas.map((s) => ({ category: s.category, schemaVersionId: s.id, threshold: 0.9 })),
  };
  return { input, schemas, classifyPrompt, extractPrompt };
}

/** Inserts a document for the tenant in `tx`. */
export async function insertDocument(tx: TenantTx, externalId: string = randomUUID()) {
  const [doc] = await tx.db
    .insert(documents)
    .values({ tenantId: tx.tenantId, source: "api", externalId, sourceKey: `t/${tx.tenantId}/test/${externalId}` })
    .returning();
  if (!doc) throw new Error("document insert failed");
  return doc;
}
