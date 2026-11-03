import { randomUUID } from "node:crypto";
import { InboundSettings } from "@ai-triage/contracts";
import { createTenant, listAuditEvents, withTenantTx } from "@ai-triage/db";
import { DEMO_TENANT } from "@ai-triage/db/seed";
import { storageKeys } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, POSTMARK, WEB_ORIGIN } from "./test-app";

// Untrusted content (docs/security.md, M5), against the real storage service: what a stored file is
// served as, refused uploads leaving nothing behind, email limits and envelope routing.

const t = await createTestApp();
const { app, storage } = t;
let admin = "";
beforeAll(async () => {
  admin = (await t.signIn("admin@demo.test")).cookie;
});
afterAll(t.close);

const postmark = (body: unknown) =>
  app.request("/webhooks/postmark", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${POSTMARK.user}:${POSTMARK.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const email = (overrides: Record<string, unknown> = {}) => ({
  MessageID: randomUUID(),
  OriginalRecipient: DEMO_TENANT.inboundAddress,
  ToFull: [{ Email: DEMO_TENANT.inboundAddress }],
  FromFull: { Email: "ap@vendor.test", Name: "Vendor" },
  Subject: "Invoice",
  TextBody: "Please pay.",
  ...overrides,
});

describe("served files", () => {
  it("serves a file as the type the server determined, never the sender's claim", async () => {
    const key = `${storageKeys.file(randomUUID())}`;
    // A sender's "attachment": script, stored with the type it claimed.
    await storage.put(key, new TextEncoder().encode("<script>alert(1)</script>"), "text/html");

    const asHtml = await fetch(await storage.presignGet(key, 60, { mime: "text/html", filename: "x.html" }));
    expect(asHtml.headers.get("content-type")).toBe("application/octet-stream");
    expect(asHtml.headers.get("content-disposition")).toMatch(/^attachment/);

    const asPng = await fetch(await storage.presignGet(key, 60, { mime: "image/png", filename: "x.png" }));
    expect(asPng.headers.get("content-type")).toBe("image/png");
    expect(asPng.headers.get("content-disposition")).toMatch(/^inline/);
    await storage.delete([key]);
    expect(await storage.head(key)).toBeNull();
  });
});

describe("uploads", () => {
  it("refuses an .eml name with a non-email type", async () => {
    const res = await app.request("/uploads", {
      method: "POST",
      headers: { cookie: admin, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ filename: "mail.eml", size: 10, mime: "text/html" }),
    });
    expect(res.status).toBe(415);
  });
});

describe("inbound email", () => {
  it("refuses too many attachments with a 403, which Postmark doesn't retry", async () => {
    const attachments = Array.from({ length: 26 }, (_, i) => ({
      Name: `a${i}.txt`,
      ContentType: "text/plain",
      Content: Buffer.from(`attachment ${i}`).toString("base64"),
    }));
    expect((await postmark(email({ Attachments: attachments }))).status).toBe(403);
  });

  it("routes by the envelope recipient, not the To header the sender wrote", async () => {
    const res = await postmark(
      email({ OriginalRecipient: "nobody@inbound.localhost", ToFull: [{ Email: DEMO_TENANT.inboundAddress }] }),
    );
    expect(await res.json()).toEqual({ ignored: "unknown_recipient" });
  });

  it("lets an admin replace the inbound address with an unguessable one", async () => {
    const address = `old-${randomUUID().slice(0, 8)}@inbound.localhost`;
    const { id } = await createTenant(t.pool, {
      name: "Rotate",
      slug: `r-${randomUUID().slice(0, 8)}`,
      inboundAddress: address,
    });
    const tenantAdmin = await t.memberCookie(id, "admin");
    const res = await app.request("/settings/inbound/rotate", {
      method: "POST",
      headers: { cookie: tenantAdmin, origin: WEB_ORIGIN },
    });
    const { addresses } = InboundSettings.parse(await res.json());
    expect(addresses).toEqual([expect.stringMatching(/^t-[0-9a-f]{20}@inbound\.localhost$/)]);
    // Mail to the old address no longer reaches the tenant.
    expect(await (await postmark(email({ OriginalRecipient: address }))).json()).toEqual({
      ignored: "unknown_recipient",
    });
    const { events } = await withTenantTx(t.pool, id, (tx) => listAuditEvents(tx, { limit: 1 }));
    expect(events[0]).toMatchObject({ action: "settings.inbound_rotated", details: { from: [address] } });
  });
});
