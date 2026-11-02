import { sql } from "drizzle-orm";
import type pg from "pg";
import { withTenantTx } from "./tenant-tx";

// Daily LLM budget per tenant (docs/architecture.md §5). Live calls reserve their worst-case cost
// before calling Claude; the guarded UPDATE serializes on the row, so concurrent workers can't
// overshoot the cap. After the call the reservation settles to the actual cost. A worker that
// crashes in between holds its reservation until the day rolls over (errs toward blocking).

const usd = (value: number) => value.toFixed(6);

/** Reserves `amountUsd` for today (UTC). Returns the budget day, or null when the cap would be exceeded. */
export async function reserveBudget(
  pool: pg.Pool,
  tenantId: string,
  amountUsd: number,
  now: Date = new Date(),
): Promise<{ day: string } | null> {
  const day = now.toISOString().slice(0, 10);
  return withTenantTx(pool, tenantId, async ({ db }) => {
    await db.execute(sql`
      insert into llm_budget_days (tenant_id, day, cap_usd)
      select tenant_id, ${day}, daily_llm_cap_usd from tenant_settings where tenant_id = ${tenantId}
      on conflict do nothing`);
    const { rows } = await db.execute(sql`
      update llm_budget_days set reserved_usd = reserved_usd + ${usd(amountUsd)}
      where tenant_id = ${tenantId} and day = ${day}
        and spent_usd + reserved_usd + ${usd(amountUsd)} <= cap_usd
      returning day`);
    return rows.length > 0 ? { day } : null;
  });
}

/** Releases a reservation and records the actual spend (which may be zero if the call failed). */
export async function settleBudget(
  pool: pg.Pool,
  tenantId: string,
  day: string,
  reservedUsd: number,
  actualUsd: number,
): Promise<void> {
  await withTenantTx(pool, tenantId, ({ db }) =>
    db.execute(sql`
      update llm_budget_days
      set reserved_usd = greatest(reserved_usd - ${usd(reservedUsd)}, 0), spent_usd = spent_usd + ${usd(actualUsd)}
      where tenant_id = ${tenantId} and day = ${day}`),
  );
}
