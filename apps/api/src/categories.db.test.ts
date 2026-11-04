import type { CategoryList, CategoryPreview, CategorySaved, ConfigSummary } from "@ai-triage/contracts";
import { buildPipelineConfig, withTenantTx } from "@ai-triage/db";
import { newTenant } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// Settings → Categories: a tenant's own document types; every change activates a new version in
// which a person reviews every category.

const t = await createTestApp();
afterAll(t.close);

async function setup() {
  const tenantId = await newTenant(t.pool);
  await withTenantTx(t.pool, tenantId, (tx) =>
    buildPipelineConfig(tx, { categories: { invoice: { automation: "auto_when_confident" } } }),
  );
  const admin = await t.memberCookie(tenantId, "admin");
  const reviewer = await t.memberCookie(tenantId, "reviewer");
  const send = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(path, {
      method,
      headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { tenantId, admin, reviewer, send };
}

describe("Settings → Categories", () => {
  it("lists the built-ins and the starters, and warns that automation turns off", async () => {
    const { admin, reviewer, send } = await setup();
    expect((await send(reviewer, "GET", "/categories")).status).toBe(403);
    const body = (await (await send(admin, "GET", "/categories")).json()) as CategoryList;
    expect(body.categories.map((c) => [c.category, c.origin])).toEqual([
      ["contract", "builtin"],
      ["invoice", "builtin"],
      ["support_request", "builtin"],
    ]);
    expect(body.categories.find((c) => c.category === "invoice")?.fields[0]).toEqual({
      name: "vendor_name",
      required: true,
    });
    expect(body.starters.length).toBeGreaterThanOrEqual(8);
    expect(body.warnings.join(" ")).toMatch(/auto-approval off.*invoice/);
  });

  it("previews a draft's schema or its problems, saving nothing", async () => {
    const { admin, send } = await setup();
    const { starters } = (await (await send(admin, "GET", "/categories")).json()) as CategoryList;
    const ok = (await (
      await send(admin, "POST", "/categories/preview", starters[0]?.definition)
    ).json()) as CategoryPreview;
    expect(ok.issues).toEqual([]);
    expect(ok.jsonSchema).toMatchObject({ type: "object" });
    const bad = (await (
      await send(admin, "POST", "/categories/preview", { name: "invoice", description: "x", fields: [] })
    ).json()) as CategoryPreview;
    expect(bad.jsonSchema).toBeNull();
    expect(bad.issues.map((i) => i.path).sort()).toEqual(["/description", "/fields", "/name"]);
  });

  it("adds, updates and removes a custom category, each an active version reviewed by a person, audited", async () => {
    const { tenantId, admin, send } = await setup();
    const { starters } = (await (await send(admin, "GET", "/categories")).json()) as CategoryList;
    const receipt = starters.find((s) => s.id === "receipt")?.definition;
    const added = await send(admin, "POST", "/categories", receipt);
    expect(added.status).toBe(201);
    const first = (await added.json()) as CategorySaved;
    expect(first).toMatchObject({ category: "receipt", version: 1, config: { active: true, frozenAt: null } });
    expect(first.config.categories.every((c) => c.automation === "review_all")).toBe(true);

    const updated = (await (
      await send(admin, "POST", "/categories", { ...receipt, description: "Proof of a payment already made." })
    ).json()) as CategorySaved;
    expect(updated.version).toBe(2);
    const list = (await (await send(admin, "GET", "/categories")).json()) as CategoryList;
    expect(list.categories.find((c) => c.category === "receipt")).toMatchObject({ origin: "custom", version: 2 });
    expect(list.categories.find((c) => c.category === "receipt")?.definition?.description).toBe(
      "Proof of a payment already made.",
    );

    const removed = await send(admin, "DELETE", "/categories/receipt");
    expect(removed.status).toBe(200);
    const { config } = (await removed.json()) as { config: ConfigSummary };
    expect(config.categories.map((c) => c.category)).not.toContain("receipt");
    expect((await send(admin, "DELETE", "/categories/receipt")).status).toBe(404);

    const audit = await withTenantTx(t.pool, tenantId, (tx) =>
      tx.db.execute("select action from audit_events order by created_at, action"),
    );
    // One transaction per change, so one timestamp: within it, rows sort by action.
    expect(audit.rows.map((r) => r.action)).toEqual([
      "category.version_created",
      "config.activated",
      "config.created",
      "category.version_created",
      "config.activated",
      "config.created",
      "config.activated",
      "config.created",
    ]);
  });

  it("refuses a built-in name and an invalid definition", async () => {
    const { admin, send } = await setup();
    const res = await send(admin, "POST", "/categories", {
      name: "invoice",
      description: "Not allowed to shadow a built-in.",
      fields: [{ name: "x", type: "text", description: "x" }],
    });
    expect(res.status).toBe(400);
  });
});
