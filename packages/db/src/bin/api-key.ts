import { parseArgs } from "node:util";
import { createApiKey, createDb, createPool, findTenantBySlug, withTenantTx } from "../index";

// `pnpm api-key:create --tenant <slug> [--name <label>]`: prints a new tenant API key once.
// Runs as the app role (DATABASE_URL), through the same RLS as the API.

const { values } = parseArgs({ options: { tenant: { type: "string" }, name: { type: "string", default: "cli" } } });
if (!values.tenant) {
  console.error("usage: pnpm api-key:create --tenant <slug> [--name <label>]");
  process.exit(2);
}

const pool = createPool();
try {
  const tenant = await findTenantBySlug(createDb(pool), values.tenant);
  if (!tenant) throw new Error(`no tenant with slug "${values.tenant}"`);
  const { key, prefix } = await withTenantTx(pool, tenant.id, (tx) => createApiKey(tx, { name: values.name }));
  console.log(`Created API key ${prefix}… for tenant "${values.tenant}". It is shown only once:\n\n  ${key}\n`);
  console.log("Use it as TRIAGE_API_KEY for `pnpm ingest`, or as `Authorization: Bearer <key>`.");
} finally {
  await pool.end();
}
