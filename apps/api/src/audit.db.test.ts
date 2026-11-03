import { AuditEventList } from "@ai-triage/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// The audit log through the API (docs/security.md, M2): admin changes are recorded with who did
// them and the request id, and only admins can read the log.

const t = await createTestApp();
const { app } = t;
let admin = "";
let reviewer = "";
beforeAll(async () => {
  admin = (await t.signIn("admin@demo.test")).cookie;
  reviewer = (await t.signIn("reviewer@demo.test")).cookie;
});
afterAll(t.close);

const auditLog = async (cookie: string) => app.request("/settings/audit", { headers: { cookie } });

describe("GET /settings/audit", () => {
  it("records a webhook secret rotation with the admin and the request id", async () => {
    const res = await app.request("/settings/webhook/rotate", {
      method: "POST",
      headers: { cookie: admin, origin: WEB_ORIGIN, "user-agent": "audit-test" },
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id");

    const log = AuditEventList.parse(await (await auditLog(admin)).json());
    const event = log.events.find((e) => e.requestId === requestId);
    expect(event).toMatchObject({
      action: "settings.webhook_secret_rotated",
      actorType: "user",
      actorLabel: "admin@demo.test",
      userAgent: "audit-test",
    });
    // Secrets never go into the log.
    expect(JSON.stringify(log)).not.toMatch(/whsec_/);
  });

  it("is for admins only", async () => {
    expect((await auditLog(reviewer)).status).toBe(403);
  });
});
