import type { MemberRole } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { createDb } from "../index";
import { tenants } from "../schema";
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

// Filled in by later phases. Kept as named steps so the seed's shape is visible now.

/** Phase 2: category schema versions, prompt versions and the active pipeline config. */
export async function seedPipelineConfig(_demo: DemoSeed): Promise<void> {}

/** Phase 2: ~60 synthetic documents ingested through the real pipeline in replay mode. */
export async function seedDocuments(_demo: DemoSeed): Promise<void> {}

/** Phase 4: the labeled eval dataset with dev / calib / test splits. */
export async function seedEvalDataset(_demo: DemoSeed): Promise<void> {}
