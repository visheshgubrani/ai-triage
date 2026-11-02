import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, createPool, findModelPrice, reserveBudget, settleBudget, withTenantTx } from "./index";
import { llmBudgetDays, tenantSettings } from "./schema";
import { newTenant, testDbUrls } from "./testing";

const app = createPool(testDbUrls().appUrl);
let tenantId: string;

beforeAll(async () => {
  tenantId = await newTenant(app);
  await withTenantTx(app, tenantId, ({ db }) => db.update(tenantSettings).set({ dailyLlmCapUsd: "5" }));
});
afterAll(() => app.end());

it("lets exactly as many concurrent reservations through as the cap allows", async () => {
  const day = new Date("2026-11-03T12:00:00Z");
  const results = await Promise.all(Array.from({ length: 20 }, () => reserveBudget(app, tenantId, 1, day)));
  expect(results.filter(Boolean)).toHaveLength(5);

  const row = async () =>
    (
      await withTenantTx(app, tenantId, ({ db }) =>
        db.select().from(llmBudgetDays).where(eq(llmBudgetDays.day, "2026-11-03")),
      )
    )[0];
  expect(await row()).toMatchObject({ capUsd: "5.0000", reservedUsd: "5.000000", spentUsd: "0.000000" });

  // Settling releases the worst case and records the actual cost, which frees room.
  await settleBudget(app, tenantId, "2026-11-03", 1, 0.25);
  expect(await row()).toMatchObject({ reservedUsd: "4.000000", spentUsd: "0.250000" });
  expect(await reserveBudget(app, tenantId, 0.75, day)).toEqual({ day: "2026-11-03" });
  expect(await reserveBudget(app, tenantId, 0.01, day)).toBeNull();
});

it("picks the prompt-size price tier", async () => {
  const db = createDb(app);
  expect(await findModelPrice(db, "claude-haiku-5-5", 1_000)).toMatchObject({ inputPerMtok: 0.1, outputPerMtok: 0.5 });
  expect(await findModelPrice(db, "claude-haiku-5-5", 150_000)).toMatchObject({
    inputPerMtok: 0.5,
    outputPerMtok: 2.5,
  });
  expect(await findModelPrice(db, "claude-opus-5-5", 150_000)).toMatchObject({ inputPerMtok: 4, outputPerMtok: 20 });
  expect(await findModelPrice(db, "claude-opus-4-8", 10)).toBeNull();
  // Dated before the seeded rows (which carry their verification day): the earliest row applies.
  expect(await findModelPrice(db, "claude-opus-5-5", 10, new Date("2020-01-01"))).toMatchObject({ inputPerMtok: 4 });
});
