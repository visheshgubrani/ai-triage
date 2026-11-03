import type { MemberRole } from "@ai-triage/core";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { accounts, memberships, users } from "./schema";

export interface PasswordUser {
  email: string;
  name: string;
  password: string;
}

/**
 * Get-or-create an email/password user, writing the same rows as Better Auth's email sign-up
 * (a user plus a `credential` account holding the hash). Used by seeds and tests, since public
 * sign-up is disabled and that also blocks server-side sign-up. An existing password is kept.
 */
export async function ensurePasswordUser(db: Db, input: PasswordUser): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ email: input.email, name: input.name, emailVerified: true })
      .onConflictDoNothing({ target: users.email });
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (!user) throw new Error(`user ${input.email} missing after insert`);

    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, user.id));
    if (!account) {
      await tx.insert(accounts).values({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(input.password),
      });
    }
    return user.id;
  });
}

/** Adds a membership; an existing one (whatever its role) is left alone. */
export async function addMembership(db: Db, userId: string, tenantId: string, role: MemberRole): Promise<void> {
  await db
    .insert(memberships)
    .values({ organizationId: tenantId, userId, role })
    .onConflictDoNothing({ target: [memberships.organizationId, memberships.userId] });
}

/** Whether the user can sign in with a password (a `credential` account with a hash). */
export async function hasPassword(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  return rows.some((r) => !!r.password);
}

/** Whether the user has TOTP turned on, and the tenants they belong to (for audit events). */
export async function userSecurityState(db: Db, userId: string) {
  const [user] = await db.select({ twoFactorEnabled: users.twoFactorEnabled }).from(users).where(eq(users.id, userId));
  const tenants = await db
    .select({ tenantId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  return { twoFactorEnabled: user?.twoFactorEnabled ?? false, tenantIds: tenants.map((t) => t.tenantId) };
}
