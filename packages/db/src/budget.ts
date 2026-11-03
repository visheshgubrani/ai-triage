import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { llmBudgetDays, tenantSettings } from "./schema";
import { type TenantTx, withTenantTx } from "./tenant-tx";

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

/** The tenant's daily cap and today's (UTC) spend and open reservations. */
export async function getBudget(tx: TenantTx, now: Date = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const [settings] = await tx.db.select({ cap: tenantSettings.dailyLlmCapUsd }).from(tenantSettings);
  const [today] = await tx.db
    .select({ spent: llmBudgetDays.spentUsd, reserved: llmBudgetDays.reservedUsd })
    .from(llmBudgetDays)
    .where(eq(llmBudgetDays.day, day));
  return {
    day,
    capUsd: Number(settings?.cap ?? 0),
    spentUsd: Number(today?.spent ?? 0),
    reservedUsd: Number(today?.reserved ?? 0),
  };
}

/** Sets the daily cap. Today's budget row takes it at once (it copied the old cap when it was made). */
export async function setBudgetCap(tx: TenantTx, capUsd: number, now: Date = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await tx.db
    .update(tenantSettings)
    .set({ dailyLlmCapUsd: usd(capUsd) })
    .where(eq(tenantSettings.tenantId, tx.tenantId));
  await tx.db
    .update(llmBudgetDays)
    .set({ capUsd: usd(capUsd) })
    .where(eq(llmBudgetDays.day, day));
}
