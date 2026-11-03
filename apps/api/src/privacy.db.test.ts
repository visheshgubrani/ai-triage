import { buildPipelineConfig, listAuditEvents, withTenantTx } from "@ai-triage/db";
import { newTenant, seedReviewTask } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// Deleting a document from the API (docs/security.md, M7): admins only, audited without content.

const t = await createTestApp();
const { app, pool } = t;
afterAll(t.close);

const del = (id: string, cookie: string) =>
  app.request(`/documents/${id}`, { method: "DELETE", headers: { cookie, origin: WEB_ORIGIN } });

describe("DELETE /documents/:id", () => {
  it("lets an admin delete a document, records it, and refuses reviewers and other tenants", async () => {
    const tenantId = await newTenant(pool);
    const documentId = await withTenantTx(pool, tenantId, async (tx) => {
      await buildPipelineConfig(tx);
      return (await seedReviewTask(tx)).documentId;
    });
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    expect((await del(documentId, reviewer)).status).toBe(403);
    const outsider = await t.memberCookie(await newTenant(pool), "admin");
    expect((await del(documentId, outsider)).status).toBe(404);

    const admin = await t.memberCookie(tenantId, "admin");
    expect((await del(documentId, admin)).status).toBe(200);
    expect((await app.request(`/documents/${documentId}`, { headers: { cookie: admin } })).status).toBe(404);
    expect((await del(documentId, admin)).status).toBe(404);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 1 }));
    expect(events[0]).toMatchObject({ action: "document.purged", targetId: documentId });
    expect(events[0]?.details).toHaveProperty("externalIdSha256");
  });
});
