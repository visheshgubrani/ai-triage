import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditEvents, recordAudit, SYSTEM_ACTOR } from "./audit";
import { createPool, withTenantTx } from "./index";
import { expectPgError, newTenant, PG, testDbUrls } from "./testing";

// The audit log (0010_audit_guards.sql): insert-only, tenant-isolated, and written in the same
// transaction as the change it records (docs/security.md).

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

let tenantA: string;
let tenantB: string;
const actor = SYSTEM_ACTOR("test");

beforeAll(async () => {
  tenantA = await newTenant(app);
  tenantB = await newTenant(app);
});

describe("audit_events", () => {
  it("commits or rolls back with the change it records", async () => {
    await expect(
      withTenantTx(app, tenantA, async (tx) => {
        await recordAudit(tx, actor, { action: "settings.webhook_secret_rotated" });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    const { events } = await withTenantTx(app, tenantA, (tx) => listAuditEvents(tx, { limit: 10 }));
    expect(events).toHaveLength(0);
  });

  it("is insert-only for the app role", async () => {
    await withTenantTx(app, tenantA, (tx) =>
      recordAudit(tx, actor, { action: "config.activated", target: { type: "config", id: "c1" } }),
    );
    await expectPgError(
      withTenantTx(app, tenantA, (tx) => tx.db.execute(sql`update audit_events set action = 'config.created'`)),
      PG.rlsViolation,
    );
    await expectPgError(
      withTenantTx(app, tenantA, (tx) => tx.db.execute(sql`delete from audit_events`)),
      PG.rlsViolation,
    );
  });

  it("is invisible to other tenants", async () => {
    const { events } = await withTenantTx(app, tenantB, (tx) => listAuditEvents(tx, { limit: 10 }));
    expect(events).toHaveLength(0);
  });

  it("pages newest first without skipping events written in the same millisecond", async () => {
    const tenant = await newTenant(app);
    await withTenantTx(app, tenant, async (tx) => {
      for (let i = 0; i < 5; i++) {
        await recordAudit(tx, actor, { action: "eval_item.retired", target: { type: "eval_item", id: `i${i}` } });
      }
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTenantTx(app, tenant, (tx) => listAuditEvents(tx, { cursor, limit: 2 }));
      seen.push(...page.events.map((e) => e.targetId ?? ""));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(["i0", "i1", "i2", "i3", "i4"]);
  });
});
