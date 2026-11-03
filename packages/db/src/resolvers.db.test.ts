import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiKey,
  createDb,
  createPool,
  resolveApiKey,
  resolveInboundAddress,
  revokeApiKey,
  withTenantTx,
} from "./index";
import { apiKeys, inboundAddresses } from "./schema";
import { DEMO_TENANT } from "./seed";
import { newTenant, testDbUrls } from "./testing";

const app = createPool(testDbUrls().appUrl);
const db = createDb(app);
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  tenantA = await newTenant(app);
  tenantB = await newTenant(app);
});
afterAll(() => app.end());

describe("resolve_inbound_address", () => {
  it("maps an inbound address to its tenant, case-insensitively", async () => {
    const [demo] = (await db.execute<{ id: string }>(sql`select id from tenants where slug = ${DEMO_TENANT.slug}`))
      .rows;
    expect(await resolveInboundAddress(db, DEMO_TENANT.inboundAddress.toUpperCase())).toBe(demo?.id);
    expect(await resolveInboundAddress(db, "nobody@inbound.localhost")).toBeNull();
  });
});

describe("API keys", () => {
  it("resolves a live key to its tenant, and not once revoked", async () => {
    const { id, key, prefix } = await withTenantTx(app, tenantA, (tx) => createApiKey(tx, { name: "test" }));
    expect(key.startsWith(`${prefix}_`)).toBe(true);
    expect(await resolveApiKey(db, key)).toEqual({ tenantId: tenantA, keyId: id });
    // Change the last character (to one it isn't, or the "changed" key is the key itself).
    expect(await resolveApiKey(db, `${key.slice(0, -1)}${key.endsWith("x") ? "y" : "x"}`)).toBeNull();
    expect(await resolveApiKey(db, "not-a-key")).toBeNull();

    await withTenantTx(app, tenantA, (tx) => revokeApiKey(tx, id));
    expect(await resolveApiKey(db, key)).toBeNull();
  });

  it("doesn't let the app role read keys or addresses outside its tenant", async () => {
    await withTenantTx(app, tenantA, (tx) => createApiKey(tx, { name: "a" }));
    expect(await db.select().from(apiKeys)).toEqual([]); // no tenant context
    expect(await db.select().from(inboundAddresses)).toEqual([]);
    const seenByB = await withTenantTx(app, tenantB, ({ db }) => db.select().from(apiKeys));
    expect(seenByB).toEqual([]);
  });
});
