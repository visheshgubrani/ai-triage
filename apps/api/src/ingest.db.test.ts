import { randomUUID } from "node:crypto";
import { QUEUES } from "@ai-triage/core";
import { createApiKey, getDocumentDetail, insertUpload, revokeApiKey, stageJobId, withTenantTx } from "@ai-triage/db";
import { DEMO_TENANT } from "@ai-triage/db/seed";
import { newTenant } from "@ai-triage/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, POSTMARK, WEB_ORIGIN } from "./test-app";

// The ingestion paths end to end against Postgres and RustFS: upload (presign → PUT → complete),
// the Postmark webhook and the REST API. Each creates a document, run #1 and a parse job.

const t = await createTestApp();
const { app, pool, boss } = t;

/** Owner-free reads that aren't tenant data (tenants, users, pg-boss jobs) go through the pool directly. */
const one = async <T>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0] as T;
let demoId: string;
let admin: string;

beforeAll(async () => {
  demoId = (await one<{ id: string }>("select id from tenants where slug = $1", [DEMO_TENANT.slug])).id;
  admin = (await t.signIn("admin@demo.test")).cookie;
});
afterAll(t.close);

const json = (cookie: string, body: unknown) => ({
  method: "POST",
  headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function parseJobFor(tenantId: string, documentId: string) {
  const detail = await withTenantTx(pool, tenantId, (tx) => getDocumentDetail(tx, documentId));
  const runId = detail?.document.currentRunId ?? "";
  return { doc: detail?.document, job: await boss.getJobById(QUEUES.parse, stageJobId(runId, "parse")) };
}

async function upload(cookie: string, bytes: Uint8Array, mime = "text/plain", size = bytes.length) {
  const res = await app.request("/uploads", json(cookie, { filename: "note.txt", size, mime }));
  expect(res.status).toBe(201);
  const created = (await res.json()) as { uploadId: string; url: string; headers: Record<string, string> };
  const put = await fetch(created.url, { method: "PUT", headers: created.headers, body: bytes });
  return { uploadId: created.uploadId, putStatus: put.status };
}

describe("uploads", () => {
  it("presign → PUT → complete creates the document, its run and a parse job; completing again is a duplicate", async () => {
    const { uploadId } = await upload(admin, new TextEncoder().encode(`Order ${randomUUID()} never arrived.`));
    const done = await app.request(`/uploads/${uploadId}/complete`, json(admin, {}));
    expect(done.status).toBe(201);
    const { documentId, duplicate } = (await done.json()) as { documentId: string; duplicate: boolean };
    expect(duplicate).toBe(false);
    const { doc, job } = await parseJobFor(demoId, documentId);
    expect(doc).toMatchObject({
      source: "upload",
      mime: "text/plain",
      title: "note.txt",
      processingStatus: "received",
    });
    expect(doc?.sourceKey).toMatch(new RegExp(`^t/${demoId}/u/`));
    expect(job).toMatchObject({ data: { tenantId: demoId, documentId } });

    const again = await app.request(`/uploads/${uploadId}/complete`, json(admin, {}));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ documentId, duplicate: true });
  });

  it("can't complete another tenant's upload", async () => {
    const { uploadId } = await upload(admin, new TextEncoder().encode(`secret ${randomUUID()}`));
    const otherTenant = await newTenant(pool);
    const outsider = await t.memberCookie(otherTenant, "admin");
    const res = await app.request(`/uploads/${uploadId}/complete`, json(outsider, {}));
    expect(res.status).toBe(404);
  });

  it("rejects a size mismatch, an expired upload, a missing object and a bad type", async () => {
    // The size is signed into the upload URL, so storage itself refuses another size.
    const mismatch = await upload(admin, new TextEncoder().encode("short"), "text/plain", 100);
    expect(mismatch.putStatus).not.toBe(200);
    expect((await app.request(`/uploads/${mismatch.uploadId}/complete`, json(admin, {}))).status).toBe(409);

    const userId = (await one<{ id: string }>("select id from users limit 1")).id;
    const expired = await withTenantTx(pool, demoId, (tx) =>
      insertUpload(tx, {
        storageKey: `t/${demoId}/u/${randomUUID()}`,
        filename: "x.txt",
        expectedSize: 1,
        expectedMime: "text/plain",
        expiresAt: new Date(Date.now() - 1000),
        createdBy: userId,
      }),
    );
    expect((await app.request(`/uploads/${expired}/complete`, json(admin, {}))).status).toBe(410);

    const res = await app.request("/uploads", json(admin, { filename: "x.txt", size: 3, mime: "text/plain" }));
    const { uploadId } = (await res.json()) as { uploadId: string };
    expect((await app.request(`/uploads/${uploadId}/complete`, json(admin, {}))).status).toBe(409);

    const zip = await app.request("/uploads", json(admin, { filename: "a.zip", size: 3, mime: "application/zip" }));
    expect(zip.status).toBe(415);
    expect((await app.request(`/uploads/${randomUUID()}/complete`, json(admin, {}))).status).toBe(404);
    expect((await app.request("/uploads/not-a-uuid/complete", json(admin, {}))).status).toBe(404);
  });

  it("is closed to viewers", async () => {
    const viewer = await t.memberCookie(demoId, "viewer");
    const res = await app.request("/uploads", json(viewer, { filename: "x.txt", size: 3, mime: "text/plain" }));
    expect(res.status).toBe(403);
  });
});

describe("Postmark webhook", () => {
  const auth = `Basic ${Buffer.from(`${POSTMARK.user}:${POSTMARK.password}`).toString("base64")}`;
  const payload = (messageId: string, to: string = DEMO_TENANT.inboundAddress) => ({
    MessageID: messageId,
    OriginalRecipient: to,
    ToFull: [{ Email: to }],
    FromFull: { Email: "ap@vendor.test", Name: "Vendor AP" },
    Subject: "Invoice 42",
    Date: "Mon, 2 Nov 2026 09:00:00 +0000",
    TextBody: "Please pay invoice 42.",
    Headers: [{ Name: "Message-ID", Value: `<${messageId}@vendor.test>` }],
    Attachments: [
      { Name: "inv.txt", ContentType: "text/plain", Content: Buffer.from("Invoice 42: 10.00").toString("base64") },
    ],
  });
  const post = (body: unknown, authorization = auth) =>
    app.request("/webhooks/postmark", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects bad credentials", async () => {
    const res = await post(payload("x"), `Basic ${Buffer.from("postmark:wrong").toString("base64")}`);
    expect(res.status).toBe(401);
  });

  it("ingests for the recipient's tenant, and a redelivered webhook does nothing", async () => {
    const messageId = randomUUID();
    const first = await post(payload(messageId));
    expect(first.status).toBe(200);
    const { documentId, duplicate } = (await first.json()) as { documentId: string; duplicate: boolean };
    expect(duplicate).toBe(false);
    const { doc, job } = await parseJobFor(demoId, documentId);
    expect(doc).toMatchObject({ source: "email", externalId: `${messageId}@vendor.test`, title: "Invoice 42" });
    expect(job).toBeTruthy();

    const count = async () =>
      (await one<{ n: string }>("select count(*) as n from pgboss.job where data->>'documentId' = $1", [documentId])).n;
    const jobsBefore = await count();
    const again = await post(payload(messageId));
    expect(await again.json()).toEqual({ documentId, duplicate: true });
    expect(await count()).toBe(jobsBefore);
  });

  it("takes a large payload with no Origin header at /api and at the older root path", async () => {
    // Over the 1 MiB JSON limit of the UI routes; Postmark sends no Origin.
    const big = (messageId: string) => ({
      ...payload(messageId),
      TextBody: `Please pay invoice 42.${" ".repeat(2 ** 21)}`,
    });
    const init = (body: unknown) => ({
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const atApi = await t.server.request("/api/webhooks/postmark", init(big(randomUUID())));
    expect(atApi.status).toBe(200);
    expect(atApi.headers.get("deprecation")).toBeNull();
    const atRoot = await t.server.request("/webhooks/postmark", init(big(randomUUID())));
    expect(atRoot.status).toBe(200);
    expect(atRoot.headers.get("deprecation")).toBe("true");
    expect(atRoot.headers.get("link")).toBe('</api/webhooks/postmark>; rel="successor-version"');
    // The root path keeps the edge stack: request ids and secure headers.
    expect(atRoot.headers.get("x-request-id")).toBeTruthy();
    expect(atRoot.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ignores mail for an unknown address", async () => {
    const res = await post(payload(randomUUID(), "nobody@inbound.localhost"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: "unknown_recipient" });
  });
});

describe("trace ids", () => {
  it("put the request's id into the job it enqueues, so the worker logs under it", async () => {
    const { key } = await withTenantTx(pool, demoId, (tx) => createApiKey(tx, { name: "trace" }));
    const form = new FormData();
    form.set("file", new File([`Trace ${randomUUID()}`], "trace.txt", { type: "text/plain" }));
    const res = await app.request("/v1/documents", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const { documentId } = (await res.json()) as { documentId: string };
    const { job } = await parseJobFor(demoId, documentId);
    expect((job as { data: { traceId?: string } }).data.traceId).toBe(res.headers.get("x-request-id"));
  });
});

describe("REST API", () => {
  const send = (key: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return app.request("/v1/documents", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  };

  it("ingests a file with a tenant API key, and refuses revoked or unknown keys", async () => {
    const { id, key } = await withTenantTx(pool, demoId, (tx) => createApiKey(tx, { name: "test" }));
    const file = new File([`Ticket ${randomUUID()}: my order is late`], "ticket.txt", { type: "text/plain" });
    const res = await send(key, file);
    expect(res.status).toBe(201);
    const { documentId } = (await res.json()) as { documentId: string };
    expect((await parseJobFor(demoId, documentId)).doc).toMatchObject({ source: "api", title: "ticket.txt" });
    expect((await send(key, file)).status).toBe(200); // same content: duplicate

    await withTenantTx(pool, demoId, (tx) => revokeApiKey(tx, id));
    expect((await send(key, file)).status).toBe(401);
    expect((await send("tri_00000000_bogusbogusbogusbogusbogusbogusbogu", file)).status).toBe(401);
  });

  it("refuses unsupported types", async () => {
    const { key } = await withTenantTx(pool, demoId, (tx) => createApiKey(tx, { name: "test" }));
    const res = await send(key, new File(["PK"], "a.zip", { type: "application/zip" }));
    expect(res.status).toBe(415);
  });
});

describe("documents", () => {
  it("lists and shows the tenant's documents, and 404s for anything else", async () => {
    const list = await app.request("/documents", { headers: { cookie: admin } });
    expect(list.status).toBe(200);
    const { documents } = (await list.json()) as { documents: { id: string }[] };
    expect(documents.length).toBeGreaterThan(0);
    const id = documents[0]?.id ?? "";
    const one = await app.request(`/documents/${id}`, { headers: { cookie: admin } });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ document: { id }, parts: [], extraction: null });
    const source = await app.request(`/documents/${id}/source`, { headers: { cookie: admin } });
    expect((await source.json()) as { url: string }).toMatchObject({ url: expect.stringContaining("X-Amz-Signature") });

    const outsider = await t.memberCookie(await newTenant(pool), "viewer");
    expect((await app.request(`/documents/${id}`, { headers: { cookie: outsider } })).status).toBe(404);
    expect((await app.request("/documents/nope", { headers: { cookie: admin } })).status).toBe(404);
  });
});
