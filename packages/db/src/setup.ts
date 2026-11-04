import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./index";
import { installation, tenants } from "./schema";

// First-run setup (docs/deploy.md): a fresh install has no tenant. The api then keeps a one-time
// token (hash only) and logs `<PUBLIC_URL>/setup#<token>`; the setup page uses it to create the
// first workspace and its admin's invitation. After that, setup is closed for good.

/** A setup token is good for a day after the api printed it. */
export const SETUP_TOKEN_TTL_MS = 24 * 3600_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Setup is open while no tenant exists and nobody has completed it. */
export async function setupNeeded(db: Db): Promise<boolean> {
  const [done] = await db.select({ at: installation.setupCompletedAt }).from(installation);
  if (done?.at) return false;
  const [row] = await db.select({ n: count() }).from(tenants);
  return (row?.n ?? 0) === 0;
}

/** A fresh setup token (any earlier one stops working). Only its hash is stored. */
export async function rotateSetupToken(db: Db, now: Date): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db
    .insert(installation)
    .values({ id: true, setupTokenHash: hash(token), setupTokenCreatedAt: now })
    .onConflictDoUpdate({ target: installation.id, set: { setupTokenHash: hash(token), setupTokenCreatedAt: now } });
  return token;
}

/**
 * Claims setup with a token, once: true for the first caller with the current, unexpired token.
 * The caller creates the workspace, then calls completeSetup (or releaseSetup if that failed).
 */
export async function claimSetup(db: Db, token: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(installation)
    .set({ setupCompletedAt: now, setupTokenHash: null })
    .where(
      and(
        eq(installation.setupTokenHash, hash(token)),
        isNull(installation.setupCompletedAt),
        sql`${installation.setupTokenCreatedAt} > ${new Date(now.getTime() - SETUP_TOKEN_TTL_MS).toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: installation.id });
  return rows.length === 1;
}

export async function completeSetup(db: Db, tenantId: string): Promise<void> {
  await db.update(installation).set({ setupTenantId: tenantId });
}

/** Creating the workspace failed after the claim: open setup again (a new token is needed). */
export async function releaseSetup(db: Db): Promise<void> {
  await db.update(installation).set({ setupCompletedAt: null });
}
