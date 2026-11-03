import { parseArgs } from "node:util";
import { createDb, createPool, deleteTenantData, findTenantBySlug } from "@ai-triage/db";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";

// `pnpm tenant:delete --tenant <slug> --yes`: deletes a tenant for good (docs/security.md,
// offboarding): every row it owns, its memberships and queued jobs, and every object under
// `t/{tenantId}/`. Runs as the database owner. There is no undo.

const { values } = parseArgs({ options: { tenant: { type: "string" }, yes: { type: "boolean", default: false } } });
if (!values.tenant) {
  console.error("usage: pnpm tenant:delete --tenant <slug> --yes");
  process.exit(2);
}
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL is not set");

const pool = createPool(ownerUrl);
try {
  const tenant = await findTenantBySlug(createDb(pool), values.tenant);
  if (!tenant) throw new Error(`no tenant with slug "${values.tenant}"`);
  if (!values.yes) {
    console.log(`This deletes tenant "${values.tenant}" (${tenant.id}) and all its data and files. Re-run with --yes.`);
    process.exit(1);
  }
  const counts = await deleteTenantData(pool, tenant.id);
  const objects = await createStorage(storageConfigFromEnv()).deletePrefix(`t/${tenant.id}/`);
  console.log(`deleted tenant "${values.tenant}": ${JSON.stringify(counts)}, ${objects} object(s)`);
} finally {
  await pool.end();
}
