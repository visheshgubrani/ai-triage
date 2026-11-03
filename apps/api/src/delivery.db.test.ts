import { randomUUID } from "node:crypto";
import type { DeliveryFailureList, WebhookSettingsResponse } from "@ai-triage/contracts";
import { QUEUES } from "@ai-triage/core";
import { buildPipelineConfig, createAction, markDeliveryFailed, withTenantTx } from "@ai-triage/db";
import { newTenant, seedReviewTask } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app";

// The outbox views (Delivery failures, Redeliver) and the admin-only webhook settings.

const t = await createTestApp();
const { app, pool, boss } = t;
afterAll(t.close);

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function failedAction() {
  const tenantId = await newTenant(pool);
  const actionId = await withTenantTx(pool, tenantId, async (tx) => {
    await buildPipelineConfig(tx);
    const task = await seedReviewTask(tx);
    const id = await createAction(tx, {
      documentId: task.documentId,
      extractionId: task.extractionId ?? "",
      payload: {},
    });
    await markDeliveryFailed(tx, { actionId: id, error: "HTTP 500", countAttempt: true });
    return id;
  });
  return { tenantId, actionId };
}

describe("delivery failures", () => {
  it("lists failed actions and redelivers one with a new job, once", async () => {
    const { tenantId, actionId } = await failedAction();
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    const list = (await (await send("GET", "/actions/failed", reviewer)).json()) as DeliveryFailureList;
    expect(list.failures).toMatchObject([{ actionId, attempts: 1, lastError: "HTTP 500", category: "invoice" }]);

    const res = await send("POST", `/actions/${actionId}/redeliver`, reviewer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actionId, status: "pending" });
    expect(await boss.findJobs(QUEUES.deliver, { data: { actionId } })).toHaveLength(1);
    const again = await send("POST", `/actions/${actionId}/redeliver`, reviewer);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "not_redeliverable" });
  });

  it("is closed to viewers and to other tenants", async () => {
    const { tenantId, actionId } = await failedAction();
    const viewer = await t.memberCookie(tenantId, "viewer");
    expect((await send("POST", `/actions/${actionId}/redeliver`, viewer)).status).toBe(403);
    const other = await t.memberCookie(await newTenant(pool), "reviewer");
    expect((await send("POST", `/actions/${actionId}/redeliver`, other)).status).toBe(404);
    expect((await send("POST", `/actions/${randomUUID()}/redeliver`, other)).status).toBe(404);
  });
});

describe("webhook settings", () => {
  it("lets an admin set an https URL, shows the new secret once, and rotates it", async () => {
    const tenantId = await newTenant(pool);
    const admin = await t.memberCookie(tenantId, "admin");
    const first = (await (
      await send("PUT", "/settings/webhook", admin, { url: "https://hooks.example.test/triage" })
    ).json()) as WebhookSettingsResponse;
    expect(first.secret).toMatch(/^whsec_/);
    expect(first.settings).toMatchObject({ url: "https://hooks.example.test/triage", secretSet: true });

    const second = (await (
      await send("PUT", "/settings/webhook", admin, { url: "https://hooks.example.test/v2" })
    ).json()) as WebhookSettingsResponse;
    expect(second.secret).toBeNull();
    const rotated = (await (await send("POST", "/settings/webhook/rotate", admin)).json()) as WebhookSettingsResponse;
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(first.secret);
    expect(await (await send("GET", "/settings/webhook", admin)).json()).toMatchObject({
      url: "https://hooks.example.test/v2",
      secretSet: true,
    });
  });

  it("refuses http URLs here (no WEBHOOK_ALLOW_HTTP), bad URLs, and non-admins", async () => {
    const tenantId = await newTenant(pool);
    const admin = await t.memberCookie(tenantId, "admin");
    expect((await send("PUT", "/settings/webhook", admin, { url: "http://hooks.example.test/x" })).status).toBe(400);
    expect((await send("PUT", "/settings/webhook", admin, { url: "ftp://hooks.example.test/x" })).status).toBe(400);
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    expect((await send("GET", "/settings/webhook", reviewer)).status).toBe(403);
    expect((await send("PUT", "/settings/webhook", reviewer, { url: "https://x.test" })).status).toBe(403);
  });
});
