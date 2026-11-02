import type { MemberRole } from "@ai-triage/core";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
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
