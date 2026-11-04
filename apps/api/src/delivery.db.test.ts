import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DeliveryFailureList, WebhookSettingsResponse } from "@ai-triage/contracts";
import { QUEUES } from "@ai-triage/core";
import { buildPipelineConfig, createAction, markDeliveryFailed, withTenantTx } from "@ai-triage/db";
import { newTenant, seedReviewTask } from "@ai-triage/db/testing";
import { verifyWebhook } from "@ai-triage/webhooks";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// The outbox views (Delivery failures, Redeliver) and the admin-only webhook settings.

const t = await createTestApp();
const { app, pool, boss } = t;
afterAll(t.close);

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
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

  it("refuses URLs that could reach a private network (SSRF), and non-admins", async () => {
    const tenantId = await newTenant(pool);
    const admin = await t.memberCookie(tenantId, "admin");
    const refused = async (url: string) => {
      const res = await send("PUT", "/settings/webhook", admin, { url });
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    expect(await refused("http://hooks.example.test/x")).toEqual({
      status: 400,
      error: expect.stringMatching(/https/),
    });
    expect((await refused("ftp://hooks.example.test/x")).status).toBe(400);
    for (const url of [
      "https://169.254.169.254/latest",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://10.1.2.3/x",
    ]) {
      expect(await refused(url)).toEqual({ status: 400, error: expect.stringMatching(/private or reserved/) });
    }
    // A public-looking name that resolves into 10/8 (the test DNS does this for "private.").
    expect(await refused("https://private.hooks.example.test/x")).toEqual({
      status: 400,
      error: expect.stringMatching(/resolves to a private/),
    });
    expect((await refused("https://user:pw@hooks.example.test/x")).status).toBe(400);
    expect((await refused("https://hooks.example.test:22/x")).status).toBe(400);
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    expect((await send("GET", "/settings/webhook", reviewer)).status).toBe(403);
    expect((await send("PUT", "/settings/webhook", reviewer, { url: "https://x.test" })).status).toBe(403);
  });

  it("shows the rotation grace period", async () => {
    const tenantId = await newTenant(pool);
    const admin = await t.memberCookie(tenantId, "admin");
    await send("PUT", "/settings/webhook", admin, { url: "https://hooks.example.test/triage" });
    const rotated = (await (await send("POST", "/settings/webhook/rotate", admin)).json()) as WebhookSettingsResponse;
    expect(rotated.settings.previousSecretValidUntil).not.toBeNull();
  });
});

describe("Send test event", () => {
  it("POSTs a signed ping through the egress guard and reports the receiver's answer", async () => {
    const received: { event?: string; signature?: string; key?: string; body: string }[] = [];
    const receiver = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      received.push({
        event: req.headers["x-triage-event"] as string,
        signature: req.headers["x-triage-signature"] as string,
        key: req.headers["idempotency-key"] as string,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const local = await createTestApp({ webhookAllowedHosts: ["127.0.0.1"] });
    try {
      const tenantId = await newTenant(local.pool);
      const admin = await local.memberCookie(tenantId, "admin");
      const request = (method: string, path: string, body?: unknown) =>
        local.app.request(path, {
          method,
          headers: { cookie: admin, origin: WEB_ORIGIN, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      expect((await request("POST", "/settings/webhook/test")).status).toBe(409);
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
      const saved = (await (await request("PUT", "/settings/webhook", { url })).json()) as WebhookSettingsResponse;
      const res = await request("POST", "/settings/webhook/test");
      expect(await res.json()).toMatchObject({ ok: true, status: 204, error: null });
      expect(received).toHaveLength(1);
      expect(received[0]?.event).toBe("ping");
      expect(
        verifyWebhook(
          saved.secret ?? "",
          received[0]?.signature ?? null,
          received[0]?.key ?? null,
          received[0]?.body ?? "",
          new Date(),
        ),
      ).toBe(true);
    } finally {
      receiver.close();
      await local.close();
    }
  });
});
