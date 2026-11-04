import { parseArgs } from "node:util";
import { API_KEY_SCOPES, type ApiKeyScope, isOneOf } from "@ai-triage/core";
import {
  createApiKey,
  createDb,
  createPool,
  findTenantBySlug,
  recordAudit,
  SYSTEM_ACTOR,
  withTenantTx,
} from "../index";

// `pnpm api-key:create --tenant <slug> [--name <label>] [--scopes ingest,read]`: prints a new
// tenant API key once. Runs as the app role (DATABASE_URL), through the same RLS as the API.

const USAGE = "usage: pnpm api-key:create --tenant <slug> [--name <label>] [--scopes ingest,read]";
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    name: { type: "string", default: "cli" },
    scopes: { type: "string", default: API_KEY_SCOPES.join(",") },
  },
});
const scopes = values.scopes.split(",").map((s) => s.trim());
if (!values.tenant || scopes.length === 0 || !scopes.every((s) => isOneOf(API_KEY_SCOPES, s))) {
  console.error(USAGE);
  process.exit(2);
}

const pool = createPool();
try {
  const tenant = await findTenantBySlug(createDb(pool), values.tenant);
  if (!tenant) throw new Error(`no tenant with slug "${values.tenant}"`);
  const { key, prefix } = await withTenantTx(pool, tenant.id, async (tx) => {
    const created = await createApiKey(tx, { name: values.name, scopes: scopes as ApiKeyScope[] });
    await recordAudit(tx, SYSTEM_ACTOR("cli: api-key:create"), {
      action: "api_key.created",
      target: { type: "api_key", id: created.id },
      details: { name: values.name, prefix: created.prefix, scopes: created.scopes },
    });
    return created;
  });
  console.log(
    `Created API key ${prefix}… (${scopes.join(", ")}) for tenant "${values.tenant}". It is shown only once:\n\n  ${key}\n`,
  );
  console.log("Use it as TRIAGE_API_KEY for `pnpm ingest`, or as `Authorization: Bearer <key>`.");
} finally {
  await pool.end();
}
