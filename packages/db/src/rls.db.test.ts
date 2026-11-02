import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertAppRole, createDb, createPool, withTenantTx } from "./index";
import { categorySchemaVersions, documentParts, documents, extractions } from "./schema";
import { expectPgError, insertDocument, newTenant, PG, testDbUrls } from "./testing";

// Tenant isolation (docs/architecture.md §3, §10): RLS and composite FKs, as the app role.

const { ownerUrl, appUrl } = testDbUrls();
const app = createPool(appUrl);
const owner = createPool(ownerUrl);
afterAll(() => Promise.all([app.end(), owner.end()]));

describe("row-level security", () => {
  it("hides another tenant's rows even when the query has no tenant filter", async () => {
    const [a, b] = await Promise.all([newTenant(app), newTenant(app)]);
    const docA = await withTenantTx(app, a, (tx) => insertDocument(tx));

    const seenByB = await withTenantTx(app, b, ({ db }) => db.select({ id: documents.id }).from(documents));
    expect(seenByB.map((d) => d.id)).not.toContain(docA.id);

    const seenByA = await withTenantTx(app, a, ({ db }) => db.select({ id: documents.id }).from(documents));
    expect(seenByA.map((d) => d.id)).toEqual([docA.id]);
  });

  it("rejects writing a row for another tenant", async () => {
    const [a, b] = await Promise.all([newTenant(app), newTenant(app)]);
    await expectPgError(
      withTenantTx(app, a, ({ db }) =>
        db.insert(documents).values({ tenantId: b, source: "api", externalId: randomUUID(), sourceKey: "k" }),
      ),
      PG.rlsViolation,
    );
  });

  it("returns no rows, not an error, without a tenant context", async () => {
    const a = await newTenant(app);
    await withTenantTx(app, a, (tx) => insertDocument(tx));
    expect(await createDb(app).select().from(documents)).toEqual([]);
  });

  it("does not leak the tenant into the next use of a pooled connection", async () => {
    const single = createPool(appUrl);
    single.options.max = 1;
    try {
      const a = await newTenant(single);
      await withTenantTx(single, a, (tx) => insertDocument(tx));
      const { rows } = await single.query<{ tenant: string | null; docs: string }>(
        "select current_setting('app.tenant_id', true) as tenant, (select count(*) from documents) as docs",
      );
      expect(rows[0]?.tenant ?? "").toBe("");
      expect(rows[0]?.docs).toBe("0");
    } finally {
      await single.end();
    }
  });

  it("runs the app as a role that cannot bypass RLS", async () => {
    await expect(assertAppRole(app)).resolves.toBeUndefined();
    await expect(assertAppRole(owner)).rejects.toThrow(/bypasses row-level security/);
  });

  it("rejects a malformed tenant id before touching the database", async () => {
    await expect(withTenantTx(app, "not-a-uuid", async () => 1)).rejects.toThrow(TypeError);
  });
});

describe("composite foreign keys", () => {
  it("reject a reference to another tenant's row, even with RLS out of the way", async () => {
    const [a, b] = await Promise.all([newTenant(app), newTenant(app)]);
    const docA = await withTenantTx(app, a, (tx) => insertDocument(tx));
    // The owner bypasses RLS, so only the composite FK stands in the way.
    await expectPgError(
      createDb(owner)
        .insert(documentParts)
        .values({ tenantId: b, documentId: docA.id, partIndex: 0, text: "x", evidenceMode: "text" }),
      PG.foreignKeyViolation,
    );
  });

  it("stop a document from pointing at another document's extraction", async () => {
    const a = await newTenant(app);
    await withTenantTx(app, a, async (tx) => {
      const [doc1, doc2] = [await insertDocument(tx), await insertDocument(tx)];
      const [schemaVersion] = await tx.db
        .insert(categorySchemaVersions)
        .values({ tenantId: a, category: "invoice", version: 1, jsonSchema: {} })
        .returning();
      const [extraction] = await tx.db
        .insert(extractions)
        .values({
          tenantId: a,
          documentId: doc1.id,
          revision: 1,
          author: "user",
          category: "invoice",
          schemaVersionId: schemaVersion?.id ?? "",
          fields: {},
        })
        .returning();
      await tx.db.execute(sql`savepoint before_bad_pointer`);
      await expectPgError(
        tx.db.update(documents).set({ currentExtractionId: extraction?.id }).where(eq(documents.id, doc2.id)),
        PG.foreignKeyViolation,
      );
      await tx.db.execute(sql`rollback to savepoint before_bad_pointer`);
      // Its own document may point at it.
      await tx.db.update(documents).set({ currentExtractionId: extraction?.id }).where(eq(documents.id, doc1.id));
    });
  });
});
