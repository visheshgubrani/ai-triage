import { afterAll, expect, it } from "vitest";
import { createPool } from "./index";
import { MODEL_PRICE_SEED, runSeed } from "./seed";
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
  (select count(*) from inbound_addresses where address = 'demo@inbound.localhost') as inbound,
  (select count(*) from pipeline_configs where tenant_id = (select id from tenants where slug = 'demo')) as configs,
  (select count(*) from category_schema_versions where tenant_id = (select id from tenants where slug = 'demo')) as schemas,
  (select count(*) from prompt_versions where tenant_id = (select id from tenants where slug = 'demo')) as prompts,
  (select count(*) from tenant_settings s join tenants t on t.id = s.tenant_id
     where t.slug = 'demo' and s.active_config_id is not null) as active`;

it("is idempotent: a second run changes no row counts", async () => {
  // The global setup already seeded once.
  const before = (await owner.query(COUNTS)).rows[0];
  expect(before).toMatchObject({
    tenants: "1",
    prices: String(MODEL_PRICE_SEED.length),
    inbound: "1",
    configs: "1",
    schemas: "3",
    prompts: "2",
    active: "1",
  });
  await runSeed(urls);
  expect((await owner.query(COUNTS)).rows[0]).toEqual(before);
});
