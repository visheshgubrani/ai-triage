import { ErrorResponse } from "@ai-triage/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSON_BODY_LIMIT } from "./security";
import { createTestApp, POSTMARK, WEB_ORIGIN } from "./test-app";

// The HTTP edge (docs/security.md, M1): headers, the Origin check on cookie writes, body limits,
// the Better Auth allowlist and the Postmark content type.

const t = await createTestApp();
const { app } = t;
let admin = "";
beforeAll(async () => {
  admin = (await t.signIn("admin@demo.test")).cookie;
});
afterAll(t.close);

const rotate = (headers: Record<string, string>) =>
  app.request("/settings/webhook/rotate", { method: "POST", headers: { cookie: admin, ...headers } });

describe("response headers", () => {
  it("sends the JSON-API security headers and a request id", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("x-request-id")).toMatch(/\S/);
    // HSTS only when the API is served over https.
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("Origin check on cookie-authenticated writes", () => {
  it("refuses a write from another origin, or with no Origin at all", async () => {
    const cases: Record<string, string>[] = [
      { origin: "http://localhost:9020" },
      { origin: "https://evil.example" },
      {},
    ];
    for (const headers of cases) {
      const res = await rotate(headers);
      expect(res.status).toBe(403);
      expect(ErrorResponse.parse(await res.json()).code).toBe("bad_origin");
    }
  });

  it("allows the same write from the web origin", async () => {
    expect((await rotate({ origin: WEB_ORIGIN })).status).toBe(200);
  });

  it("leaves reads alone", async () => {
    expect((await app.request("/settings/webhook", { headers: { cookie: admin } })).status).toBe(200);
  });

  it("doesn't apply to the machine routes, which don't use cookies", async () => {
    const res = await app.request("/webhooks/postmark", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("postmark:wrong").toString("base64")}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("body limits", () => {
  it("refuses a JSON body over the limit", async () => {
    const res = await app.request("/review/claim-next", {
      method: "POST",
      headers: { cookie: admin, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(JSON_BODY_LIMIT + 1) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("Better Auth endpoints", () => {
  it("serves only the ones the web uses", async () => {
    const res = await app.request("/api/auth/organization/update-member-role", {
      method: "POST",
      headers: { cookie: admin, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ memberId: "x", role: "admin" }),
    });
    expect(res.status).toBe(404);
    const session = await app.request("/api/auth/get-session", { headers: { cookie: admin } });
    expect(session.status).toBe(200);
  });
});

describe("Postmark webhook", () => {
  it("refuses a body that isn't JSON", async () => {
    const res = await app.request("/webhooks/postmark", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${POSTMARK.user}:${POSTMARK.password}`).toString("base64")}`,
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });
});
