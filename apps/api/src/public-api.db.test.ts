import { randomUUID } from "node:crypto";
import type {
  ClaimResponse,
  ErrorResponse,
  PublicCategoryList,
  PublicDocument,
  PublicDocumentList,
} from "@ai-triage/contracts";
import {
  activateConfig,
  buildPipelineConfig,
  createApiKey,
  createCandidateConfig,
  createCategoryVersion,
  getDocumentDetail,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, seedReviewTask, tenantQuery } from "@ai-triage/db/testing";
import { STARTERS } from "@ai-triage/schemas";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// The public API (docs/api.md): send a document in with your own reference, then look up what
// happened to it, and read the categories' schemas. Keys carry scopes; old keys only ingest.

const t = await createTestApp();
const { app, pool } = t;
afterAll(t.close);

const receipt = STARTERS.find((s) => s.id === "receipt")?.definition;
if (!receipt) throw new Error("receipt starter missing");

async function setup() {
  const tenantId = await newTenant(pool);
  await withTenantTx(pool, tenantId, (tx) => buildPipelineConfig(tx));
  const { key } = await withTenantTx(pool, tenantId, (tx) => createApiKey(tx, { name: "erp" }));
  const auth = { authorization: `Bearer ${key}` };
  const get = (path: string, headers = auth) => app.request(path, { headers });
  const send = (body: string, externalRef?: string, headers = auth) => {
    const form = new FormData();
    form.set("file", new File([body], "note.txt", { type: "text/plain" }));
    if (externalRef) form.set("external_ref", externalRef);
    return app.request("/v1/documents", { method: "POST", headers, body: form });
  };
  return { tenantId, key, auth, get, send };
}

describe("public API reads", () => {
  it("takes the sender's reference, and finds the document by its id or by that reference", async () => {
    const s = await setup();
    const ref = `PO-${randomUUID().slice(0, 8)}`;
    const res = await s.send(`Order ${randomUUID()} is late`, ref);
    expect(res.status).toBe(201);
    const { documentId } = (await res.json()) as { documentId: string };

    const one = (await (await s.get(`/v1/documents/${documentId}`)).json()) as PublicDocument;
    expect(one).toMatchObject({
      id: documentId,
      external_ref: ref,
      state: "processing",
      processing_status: "received",
      category: null,
      fields: null,
      delivered_at: null,
    });
    const found = (await (await s.get(`/v1/documents?external_ref=${ref}`)).json()) as PublicDocumentList;
    expect(found.documents.map((d) => d.id)).toEqual([documentId]);
    expect(((await (await s.get("/v1/documents?external_ref=nope")).json()) as PublicDocumentList).documents).toEqual(
      [],
    );
    // A reference over 200 characters is refused, not truncated.
    expect((await s.send("x", "r".repeat(201))).status).toBe(400);
  });

  it("reports the outcome as one state, with the reasons", async () => {
    const s = await setup();
    const review = await withTenantTx(pool, s.tenantId, (tx) => seedReviewTask(tx, { reasons: ["low_confidence"] }));
    const failed = await withTenantTx(pool, s.tenantId, (tx) => seedReviewTask(tx, { kind: "processing_failed" }));
    const a = (await (await s.get(`/v1/documents/${review.documentId}`)).json()) as PublicDocument;
    expect(a).toMatchObject({ state: "needs_review", category: "invoice", reasons: ["low_confidence"] });
    expect(a.fields).toMatchObject({ vendor_name: "Acme Supplies" });
    const b = (await (await s.get(`/v1/documents/${failed.documentId}`)).json()) as PublicDocument;
    expect(b).toMatchObject({ state: "failed", reasons: ["llm_refusal"] });
  });

  it("hides other tenants' documents", async () => {
    const s = await setup();
    const other = await setup();
    const { documentId } = (await (await other.send(`Theirs ${randomUUID()}`)).json()) as { documentId: string };
    expect((await s.get(`/v1/documents/${documentId}`)).status).toBe(404);
  });

  it("needs the read scope: keys from before scopes, and ingest-only keys, can only send", async () => {
    const s = await setup();
    const { key } = await withTenantTx(pool, s.tenantId, (tx) =>
      createApiKey(tx, { name: "relay", scopes: ["ingest"] }),
    );
    // A key created before scopes existed: the column default.
    const { key: old, id } = await withTenantTx(pool, s.tenantId, (tx) => createApiKey(tx, { name: "old" }));
    await tenantQuery(pool, s.tenantId, "update api_keys set scopes = default where id = $1", [id]);
    for (const k of [key, old]) {
      const headers = { authorization: `Bearer ${k}` };
      const res = await s.get("/v1/categories", headers);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe("missing_scope");
      expect((await s.send(`Sent ${randomUUID()}`, undefined, headers)).status).toBe(201);
    }
    const { key: readOnly } = await withTenantTx(pool, s.tenantId, (tx) =>
      createApiKey(tx, { name: "dashboard", scopes: ["read"] }),
    );
    expect((await s.send("x", undefined, { authorization: `Bearer ${readOnly}` })).status).toBe(403);
  });
});

describe("custom categories through the public API", () => {
  it("lists their schemas, and an approved one delivers and reports its own fields", async () => {
    const s = await setup();
    await withTenantTx(pool, s.tenantId, async (tx) => {
      const version = await createCategoryVersion(tx, receipt);
      const active = await tx.db.execute("select active_config_id as id from tenant_settings");
      const created = await createCandidateConfig(tx, {
        parentId: String(active.rows[0]?.id),
        name: "with receipts",
        schemaVersions: { receipt: version.id },
      });
      await activateConfig(tx, created.id);
    });
    const { categories } = (await (await s.get("/v1/categories")).json()) as PublicCategoryList;
    const schema = categories.find((c) => c.name === "receipt");
    expect(schema).toMatchObject({ origin: "custom", version: 1 });
    expect(Object.keys((schema?.json_schema.properties ?? {}) as object)).toEqual(receipt.fields.map((f) => f.name));

    const fields = { merchant_name: "Blue Bottle", purchase_date: "2026-10-03", total: 12.5, payment_method: "card" };
    const task = await withTenantTx(pool, s.tenantId, (tx) => seedReviewTask(tx, { category: "receipt", fields }));
    const reviewer = await t.memberCookie(s.tenantId, "reviewer");
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { cookie: reviewer, origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const { claimToken } = (await (await post(`/review/tasks/${task.taskId}/claim`, {})).json()) as ClaimResponse;
    const decided = await post(`/review/tasks/${task.taskId}/decisions`, {
      action: "approve",
      claimToken,
      extractionId: task.extractionId,
    });
    expect(decided.status).toBe(200);
    const detail = await withTenantTx(pool, s.tenantId, (tx) => getDocumentDetail(tx, task.documentId));
    expect(detail?.actions[0]?.payload).toMatchObject({ event: "document.approved", category: "receipt", fields });

    const doc = (await (await s.get(`/v1/documents/${task.documentId}`)).json()) as PublicDocument;
    expect(doc).toMatchObject({ state: "approved", category: "receipt", fields, delivery_status: "pending" });
  });
});
