import { afterAll, expect, it } from "vitest";
import { createPool } from "./index";
import { runSeed } from "./seed";
import { testDbUrls } from "./testing";

const urls = testDbUrls();
const owner = createPool(urls.ownerUrl);
afterAll(() => owner.end());

const COUNTS = `select
  (select count(*) from tenants where slug = 'demo') as tenants,
  (select count(*) from users) as users,
  (select count(*) from accounts) as accounts,
  (select count(*) from memberships) as memberships,
  (select count(*) from model_prices) as prices,
  (select count(*) from inbound_addresses where address = 'demo@inbound.localhost') as inbound`;

it("is idempotent: a second run changes no row counts", async () => {
  // The global setup already seeded once.
  const before = (await owner.query(COUNTS)).rows[0];
  expect(before).toMatchObject({ tenants: "1", prices: "4", inbound: "1" });
  await runSeed(urls);
  expect((await owner.query(COUNTS)).rows[0]).toEqual(before);
});
