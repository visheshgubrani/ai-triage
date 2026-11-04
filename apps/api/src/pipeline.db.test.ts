import type { ModelList, PipelineSettings } from "@ai-triage/contracts";
import { buildPipelineConfig, withTenantTx } from "@ai-triage/db";
import { newTenant } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// Settings → Pipeline: change models without evals; the new version reviews everything.

const t = await createTestApp();
afterAll(t.close);

async function setup() {
  const tenantId = await newTenant(t.pool);
  await withTenantTx(t.pool, tenantId, (tx) =>
    buildPipelineConfig(tx, { categories: { invoice: { automation: "auto_when_confident" } } }),
  );
  const admin = await t.memberCookie(tenantId, "admin");
  const reviewer = await t.memberCookie(tenantId, "reviewer");
  const put = (cookie: string, body: unknown) =>
    t.app.request("/pipeline", {
      method: "PUT",
      headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { tenantId, admin, reviewer, put };
}

describe("Settings → Pipeline", () => {
  it("lists every catalog model with whether a worker can run it", async () => {
    const { reviewer } = await setup();
    const res = await t.app.request("/models", { headers: { cookie: reviewer } });
    const { models } = (await res.json()) as ModelList;
    expect(models.map((m) => m.ref)).toContain("claude-opus-5-5");
    expect(models.every((m) => m.available || typeof m.reason === "string")).toBe(true);
  });

  it("activates a new version with the chosen models, every category reviewed, audited", async () => {
    const { tenantId, admin, reviewer, put } = await setup();
    const change = {
      classify: { model: "claude-haiku-5-5", effort: "low" },
      extract: { model: "claude-sonnet-5-5", effort: "medium" },
      senderRequire: true,
    };
    expect((await put(reviewer, change)).status).toBe(403);
    const res = await put(admin, change);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PipelineSettings;
    expect(body.config).toMatchObject({
      active: true,
      frozenAt: null,
      classify: { model: "claude-haiku-5-5", effort: "low" },
      extract: { model: "claude-sonnet-5-5", effort: "medium" },
    });
    expect(body.config.categories.every((c) => c.automation === "review_all")).toBe(true);
    expect(body.senderRequire).toBe(true);
    const audit = await withTenantTx(t.pool, tenantId, (tx) =>
      tx.db.execute("select action from audit_events where action like 'config.%' order by created_at"),
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["config.created", "config.activated"]);
  });

  it("refuses a model the catalog doesn't have, or an effort it doesn't take", async () => {
    const { admin, put } = await setup();
    const bad = await put(admin, {
      classify: { model: "gpt-0", effort: "low" },
      extract: { model: "claude-opus-5-5", effort: "low" },
      senderRequire: false,
    });
    expect(bad.status).toBe(422);
  });
});
