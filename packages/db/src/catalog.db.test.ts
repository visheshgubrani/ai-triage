import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./index";
import { APP_GROUP_ROLE } from "./roles";
import { testDbUrls } from "./testing";

// Lint the live catalog so a new table or FK can't silently skip tenant isolation.
// "Tenant table" = a public table with a tenant_id column.

const { ownerUrl } = testDbUrls();
const owner = createPool(ownerUrl);
afterAll(() => owner.end());

const TENANT_TABLES = `
  select c.oid, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)`;

describe("catalog", () => {
  it("has RLS enabled, forced and a policy on every tenant table", async () => {
    const { rows } = await owner.query<{ relname: string; rls: boolean; forced: boolean; policy: boolean }>(`
      select t.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             exists (select 1 from pg_policy p where p.polrelid = t.oid) as policy
      from (${TENANT_TABLES}) t join pg_class c on c.oid = t.oid
      order by t.relname`);
    expect(rows.length).toBeGreaterThanOrEqual(22);
    expect(rows.filter((r) => !(r.rls && r.forced && r.policy)).map((r) => r.relname)).toEqual([]);
  });

  it("puts tenant_id in the same position on both sides of every FK between tenant tables", async () => {
    const { rows } = await owner.query<{ conname: string; src: string[]; tgt: string[] }>(`
      with tt as (${TENANT_TABLES})
      select con.conname,
        array(select a.attname::text from unnest(con.conkey) with ordinality k(num, i)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.i) as src,
        array(select a.attname::text from unnest(con.confkey) with ordinality k(num, i)
              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.num order by k.i) as tgt
      from pg_constraint con
      where con.contype = 'f'
        and con.conrelid in (select oid from tt) and con.confrelid in (select oid from tt)`);
    expect(rows.length).toBeGreaterThan(30);
    const bad = rows.filter(
      (r) => r.src.indexOf("tenant_id") < 0 || r.src.indexOf("tenant_id") !== r.tgt.indexOf("tenant_id"),
    );
    expect(bad.map((r) => r.conname)).toEqual([]);
  });

  it(`grants ${APP_GROUP_ROLE} read/write on every table except read-only model_prices and append-only audit_events`, async () => {
    const { rows } = await owner.query<{ relname: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
      `select c.relname,
              has_table_privilege($1, c.oid, 'SELECT') as sel, has_table_privilege($1, c.oid, 'INSERT') as ins,
              has_table_privilege($1, c.oid, 'UPDATE') as upd, has_table_privilege($1, c.oid, 'DELETE') as del
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
      [APP_GROUP_ROLE],
    );
    for (const r of rows) {
      const writable = r.relname !== "model_prices";
      const appendOnly = r.relname === "audit_events";
      expect({ table: r.relname, sel: r.sel, ins: r.ins, upd: r.upd, del: r.del }).toEqual({
        table: r.relname,
        sel: true,
        ins: writable,
        upd: writable && !appendOnly,
        del: writable && !appendOnly,
      });
    }
  });

  it("limits app_resolver to SELECT on the two lookup tables, through definer functions only", async () => {
    const { rows: policies } = await owner.query<{ table: string; cmd: string; roles: string[] }>(`
      select c.relname as table, p.polcmd as cmd, array(select rolname::text from pg_roles where oid = any(p.polroles)) as roles
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where p.polname <> 'tenant_isolation' order by c.relname`);
    expect(policies).toEqual([
      { table: "api_keys", cmd: "r", roles: ["app_resolver"] },
      { table: "inbound_addresses", cmd: "r", roles: ["app_resolver"] },
    ]);

    const { rows: functions } = await owner.query<{
      name: string;
      owner: string;
      config: string[];
      public_exec: boolean;
    }>(`
      select p.proname as name, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef order by p.proname`);
    expect(functions).toEqual([
      { name: "resolve_api_key", owner: "app_resolver", config: ["search_path=public, pg_temp"], public_exec: false },
      {
        name: "resolve_inbound_address",
        owner: "app_resolver",
        config: ["search_path=public, pg_temp"],
        public_exec: false,
      },
    ]);

    const { rows: members } = await owner.query(
      "select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname = 'app_resolver'",
    );
    expect(members).toEqual([]);
  });

  it("guards immutable and frozen rows with triggers", async () => {
    const { rows } = await owner.query<{ table: string; trigger: string }>(`
      select c.relname as table, t.tgname as trigger
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname`);
    expect(rows).toEqual(
      expect.arrayContaining([
        { table: "actions", trigger: "actions_immutable" },
        { table: "category_schema_versions", trigger: "category_schema_versions_immutable" },
        { table: "extractions", trigger: "extractions_immutable" },
        { table: "pipeline_configs", trigger: "pipeline_configs_immutable" },
        { table: "prompt_versions", trigger: "prompt_versions_immutable" },
        { table: "review_decisions", trigger: "review_decisions_immutable" },
      ]),
    );
  });
});
