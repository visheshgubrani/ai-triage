import type { MemberRole } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { getActiveConfig } from "../configs";
import { createDb } from "../index";
import { buildPipelineConfig, DEMO_CATEGORY_SETTINGS } from "../pipeline-config";
import { tenants } from "../schema";
import { getWebhookSettings, setWebhook } from "../settings";
import { withTenantTx } from "../tenant-tx";
import { createTenant } from "../tenants";
import { addMembership, ensurePasswordUser } from "../users";

/** Dev-only credentials for the demo tenant, documented in the README. Never use outside local demos. */
export const DEMO_PASSWORD = "demo-password";

export const DEMO_TENANT = { name: "Demo", slug: "demo", inboundAddress: "demo@inbound.localhost" } as const;

export const DEMO_USERS: readonly { email: string; name: string; role: MemberRole }[] = [
  { email: "admin@demo.test", name: "Demo Admin", role: "admin" },
  { email: "reviewer@demo.test", name: "Demo Reviewer", role: "reviewer" },
];

export interface DemoSeed {
  tenantId: string;
  userIds: Record<string, string>;
}

/**
 * Creates the demo tenant and its users (get-or-create, so re-running changes nothing). Runs as the
 * app role, through the same helpers and RLS the app uses.
 */
export async function seedDemo(appPool: pg.Pool): Promise<DemoSeed> {
  const db = createDb(appPool);

  const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, DEMO_TENANT.slug));
  const tenantId = existing?.id ?? (await createTenant(appPool, DEMO_TENANT)).id;

  const userIds: Record<string, string> = {};
  for (const { email, name, role } of DEMO_USERS) {
    const userId = await ensurePasswordUser(db, { email, name, password: DEMO_PASSWORD });
    await addMembership(db, userId, tenantId, role);
    userIds[email] = userId;
  }
  return { tenantId, userIds };
}

/** The demo tenant's active pipeline config: built-in categories, v1 prompts, Opus 5.5 at low effort. */
export async function seedPipelineConfig(appPool: pg.Pool, demo: DemoSeed): Promise<void> {
  await withTenantTx(appPool, demo.tenantId, async (tx) => {
    if (await getActiveConfig(tx)) return;
    await buildPipelineConfig(tx, { name: "Demo config", categories: DEMO_CATEGORY_SETTINGS });
  });
}

/**
 * Points the demo tenant's webhook at the local catcher (DEMO_WEBHOOK_URL / DEMO_WEBHOOK_SECRET), so
 * approvals show up there. Leaves a webhook an admin already configured alone.
 */
export async function seedDemoWebhook(appPool: pg.Pool, demo: DemoSeed, webhook: { url: string; secret: string }) {
  await withTenantTx(appPool, demo.tenantId, async (tx) => {
    if ((await getWebhookSettings(tx)).url) return;
    await setWebhook(tx, webhook);
  });
}
