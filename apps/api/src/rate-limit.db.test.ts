import { randomUUID } from "node:crypto";
import { BudgetSettings, ErrorResponse } from "@ai-triage/contracts";
import { buildPipelineConfig, createTenant, ensurePasswordUser, listAuditEvents, withTenantTx } from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { afterAll, describe, expect, it } from "vitest";
import { RATE_LIMITS } from "./rate-limit";
import { createTestApp, POSTMARK, WEB_ORIGIN } from "./test-app";

// Abuse controls (docs/security.md, M4). Counters live in the shared test database, so each test
// uses buckets of its own: a fresh account, user or tenant.

const tight = { ...RATE_LIMITS, signInPerIp: { max: 1000, windowSeconds: 60 } };
const t = await createTestApp({
  rateLimits: {
    ...tight,
    signInPerEmail: { max: 2, windowSeconds: 60 },
    writesPerUser: { max: 2, windowSeconds: 60 },
    postmarkPerTenant: { max: 1, windowSeconds: 60 },
  },
});
const { app, pool, db } = t;
afterAll(t.close);

const signIn = (email: string) =>
  app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: "wrong-password-123" }),
  });

describe("rate limits", () => {
  it("limits sign-in attempts per account, with Retry-After", async () => {
    const email = `target-${randomUUID().slice(0, 8)}@test.test`;
    await ensurePasswordUser(db, { email, name: "Target", password: DEMO_PASSWORD });
    expect((await signIn(email)).status).toBe(401);
    expect((await signIn(email)).status).toBe(401);
    const third = await signIn(email);
    expect(third.status).toBe(429);
    expect(ErrorResponse.parse(await third.json()).code).toBe("rate_limited");
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another account isn't affected.
    expect((await signIn(`other-${randomUUID().slice(0, 8)}@test.test`)).status).toBe(401);
  });

  it("limits a member's writes, not their reads", async () => {
    const tenantId = (await createTenant(pool, { name: "RL", slug: `rl-${randomUUID().slice(0, 8)}` })).id;
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    const claim = () =>
      app.request("/review/claim-next", {
        method: "POST",
        headers: { cookie: reviewer, origin: WEB_ORIGIN, "content-type": "application/json" },
        body: "{}",
      });
    expect((await claim()).status).not.toBe(429);
    expect((await claim()).status).not.toBe(429);
    expect((await claim()).status).toBe(429);
    expect((await app.request("/review/tasks", { headers: { cookie: reviewer } })).status).toBe(200);
  });

  it("limits inbound email per tenant (Postmark retries a 429 later)", async () => {
    const address = `rl-${randomUUID().slice(0, 8)}@inbound.localhost`;
    const inbound = await createTenant(pool, {
      name: "Inbound",
      slug: `in-${randomUUID().slice(0, 8)}`,
      inboundAddress: address,
    });
    await withTenantTx(pool, inbound.id, (tx) => buildPipelineConfig(tx));
    const send = () =>
      app.request("/webhooks/postmark", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${POSTMARK.user}:${POSTMARK.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          MessageID: randomUUID(),
          OriginalRecipient: address,
          ToFull: [{ Email: address }],
          FromFull: { Email: "ap@vendor.test", Name: "Vendor" },
          Subject: "Invoice",
          TextBody: "Please pay.",
        }),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

describe("daily LLM budget", () => {
  it("lets an admin change the cap, records it, and refuses others", async () => {
    const tenantId = (await createTenant(pool, { name: "Budget", slug: `b-${randomUUID().slice(0, 8)}` })).id;
    const admin = await t.memberCookie(tenantId, "admin");
    const before = BudgetSettings.parse(
      await (await app.request("/settings/budget", { headers: { cookie: admin } })).json(),
    );
    expect(before.capUsd).toBe(5);
    const res = await app.request("/settings/budget", {
      method: "PUT",
      headers: { cookie: admin, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ capUsd: 12.5 }),
    });
    expect(BudgetSettings.parse(await res.json()).capUsd).toBe(12.5);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 5 }));
    expect(events[0]).toMatchObject({ action: "settings.budget_updated", details: { fromUsd: 5, toUsd: 12.5 } });

    const reviewer = await t.memberCookie(tenantId, "reviewer");
    expect((await app.request("/settings/budget", { headers: { cookie: reviewer } })).status).toBe(403);
  });
});
