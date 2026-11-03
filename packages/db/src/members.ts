import { createHash, randomBytes } from "node:crypto";
import {
  INVITATION_TTL_DAYS,
  type InvitationAcceptMethod,
  isOneOf,
  MEMBER_ROLES,
  type MemberErrorCode,
  type MemberRole,
} from "@ai-triage/core";
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { type AuditActor, recordAudit } from "./audit";
import type { Db } from "./index";
import { accounts, invitations, memberships, sessions, tenants, users } from "./schema";
import { type TenantTx, withTenantTx } from "./tenant-tx";

// Members and invitations (docs/architecture.md §3). Memberships and invitations are Better Auth's
// global tables, but every change here runs inside the tenant's transaction and filters on its id,
// so the change and its audit event commit together. There is no outbound email: an invitation is
// a link the admin copies, carrying a random token of which only the SHA-256 is stored.

export class MemberError extends Error {
  override name = "MemberError";
  constructor(
    readonly code: MemberErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  joinedAt: Date;
  twoFactorEnabled: boolean;
  /** The Workspace domain the user signed up with through Google, if any. */
  hostedDomain: string | null;
  /** How the user can sign in: `credential` (a password) and/or `google`. */
  signInMethods: string[];
}

export async function listMembers(tx: TenantTx): Promise<Member[]> {
  const rows = await tx.db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      twoFactorEnabled: users.twoFactorEnabled,
      hostedDomain: users.hostedDomain,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, tx.tenantId))
    .orderBy(asc(memberships.createdAt));
  const methods = rows.length
    ? await tx.db
        .select({ userId: accounts.userId, providerId: accounts.providerId })
        .from(accounts)
        .where(
          inArray(
            accounts.userId,
            rows.map((r) => r.userId),
          ),
        )
    : [];
  return rows
    .filter((r) => isOneOf(MEMBER_ROLES, r.role))
    .map((r) => ({
      ...r,
      role: r.role as MemberRole,
      signInMethods: [...new Set(methods.filter((m) => m.userId === r.userId).map((m) => m.providerId))].sort(),
    }));
}

/**
 * Locks the tenant's admin memberships, then refuses a change that would leave it without one.
 * Locking them all (not just the target) serializes two admins demoting each other at once.
 */
async function assertAdminRemains(tx: TenantTx, userId: string): Promise<void> {
  const admins = await tx.db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, tx.tenantId), eq(memberships.role, "admin")))
    .for("update");
  if (admins.every((a) => a.userId === userId)) {
    throw new MemberError("last_admin", "A workspace needs at least one admin");
  }
}

async function lockMembership(tx: TenantTx, userId: string) {
  const [row] = await tx.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.organizationId, tx.tenantId), eq(memberships.userId, userId)))
    .for("update");
  if (!row) throw new MemberError("not_member", "Not a member of this workspace");
  return row;
}

export async function changeMemberRole(
  tx: TenantTx,
  actor: AuditActor,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const current = await lockMembership(tx, userId);
  if (current.role === role) return;
  if (current.role === "admin") await assertAdminRemains(tx, userId);
  await tx.db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.organizationId, tx.tenantId), eq(memberships.userId, userId)));
  await recordAudit(tx, actor, {
    action: "member.role_changed",
    target: { type: "user", id: userId },
    details: { from: current.role, to: role },
  });
}

/**
 * Removes a member. Access ends with the next request (memberships are re-checked every time), and
 * their sessions stop pointing at this tenant.
 */
export async function removeMember(tx: TenantTx, actor: AuditActor, userId: string): Promise<void> {
  const current = await lockMembership(tx, userId);
  if (current.role === "admin") await assertAdminRemains(tx, userId);
  await tx.db
    .delete(memberships)
    .where(and(eq(memberships.organizationId, tx.tenantId), eq(memberships.userId, userId)));
  await tx.db
    .update(sessions)
    .set({ activeOrganizationId: null })
    .where(and(eq(sessions.userId, userId), eq(sessions.activeOrganizationId, tx.tenantId)));
  await recordAudit(tx, actor, {
    action: "member.removed",
    target: { type: "user", id: userId },
    details: { role: current.role },
  });
}

// ── Invitations ──────────────────────────────────────────────────────────────────────────────

export interface Invitation {
  id: string;
  email: string;
  role: MemberRole;
  acceptWith: InvitationAcceptMethod;
  expiresAt: Date;
  createdAt: Date;
}

export interface NewInvitation {
  email: string;
  role: MemberRole;
  acceptWith: InvitationAcceptMethod;
  /** Null when the CLI invites (tenant:create). */
  inviterId: string | null;
  now: Date;
}

/**
 * Creates an invitation and returns its token, which only this call ever sees (the link is
 * `${WEB_ORIGIN}/invite#<token>`). Inviting an email again replaces its pending invitation, so only
 * the newest link works. Refuses someone who is already a member.
 */
export async function createInvitation(
  tx: TenantTx,
  actor: AuditActor,
  input: NewInvitation,
): Promise<{ invitation: Invitation; token: string }> {
  const email = input.email.trim().toLowerCase();
  const [member] = await tx.db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, tx.tenantId), eq(users.email, email)));
  if (member) throw new MemberError("already_member", "Already a member of this workspace");

  await tx.db
    .update(invitations)
    .set({ status: "revoked" })
    .where(
      and(eq(invitations.organizationId, tx.tenantId), eq(invitations.email, email), eq(invitations.status, "pending")),
    );
  const token = randomBytes(32).toString("base64url");
  const [row] = await tx.db
    .insert(invitations)
    .values({
      organizationId: tx.tenantId,
      email,
      role: input.role,
      acceptWith: input.acceptWith,
      inviterId: input.inviterId,
      tokenHash: hashToken(token),
      expiresAt: new Date(input.now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
    })
    .returning();
  if (!row) throw new Error("invitation insert returned nothing");
  await recordAudit(tx, actor, {
    action: "member.invited",
    target: { type: "invitation", id: row.id },
    details: { email, role: input.role, acceptWith: input.acceptWith },
  });
  return { invitation: toInvitation(row), token };
}

function toInvitation(row: typeof invitations.$inferSelect): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: isOneOf(MEMBER_ROLES, row.role) ? row.role : "viewer",
    acceptWith: row.acceptWith === "google_or_password" ? "google_or_password" : "google",
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Pending invitations that haven't expired, newest first. */
export async function listInvitations(tx: TenantTx, now: Date): Promise<Invitation[]> {
  const rows = await tx.db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, tx.tenantId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .orderBy(sql`${invitations.createdAt} desc`);
  return rows.map(toInvitation);
}

export async function revokeInvitation(tx: TenantTx, actor: AuditActor, id: string): Promise<void> {
  const [row] = await tx.db
    .update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.organizationId, tx.tenantId), eq(invitations.id, id), eq(invitations.status, "pending")))
    .returning({ email: invitations.email });
  if (!row) throw new MemberError("invitation_invalid", "No pending invitation with that id");
  await recordAudit(tx, actor, {
    action: "member.invitation_revoked",
    target: { type: "invitation", id },
    details: { email: row.email },
  });
}

/** What the invite page shows before anyone signs in (looked up by token, before a tenant is known). */
export interface InvitationPreview {
  tenantName: string;
  email: string;
  role: MemberRole;
  acceptWith: InvitationAcceptMethod;
  expiresAt: Date;
}

async function findPending(db: Db | TenantTx["db"], token: string, now: Date) {
  const [row] = await db
    .select({ invitation: invitations, tenantName: tenants.name })
    .from(invitations)
    .innerJoin(tenants, eq(tenants.id, invitations.organizationId))
    .where(and(eq(invitations.tokenHash, hashToken(token)), eq(invitations.status, "pending")));
  if (!row || row.invitation.expiresAt <= now) return null;
  return row;
}

export async function previewInvitation(db: Db, token: string, now: Date): Promise<InvitationPreview | null> {
  const row = await findPending(db, token, now);
  if (!row) return null;
  const { email, role, acceptWith, expiresAt } = toInvitation(row.invitation);
  return { tenantName: row.tenantName, email, role, acceptWith, expiresAt };
}

/** Whether someone holds a pending invitation for this email (lets Google create their user). */
export async function hasPendingInvitation(db: Db, email: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email.toLowerCase()),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Locks the invitation the token names inside its tenant's transaction, then marks it used and adds
 * the membership. Single use: a second accept (or a revoke that won the lock) finds no pending row.
 */
async function consume(
  db: Db,
  token: string,
  now: Date,
  fn: (tx: TenantTx, invitation: typeof invitations.$inferSelect) => Promise<{ userId: string; actor: AuditActor }>,
): Promise<{ tenantId: string; userId: string }> {
  const found = await findPending(db, token, now);
  if (!found) throw new MemberError("invitation_invalid", "This invitation link is invalid, used or expired");
  const tenantId = found.invitation.organizationId;
  return withTenantTx(db.$client, tenantId, async (tx) => {
    const [invitation] = await tx.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, found.invitation.id), eq(invitations.status, "pending")))
      .for("update");
    if (!invitation || invitation.expiresAt <= now) {
      throw new MemberError("invitation_invalid", "This invitation link is invalid, used or expired");
    }
    const { userId, actor } = await fn(tx, invitation);
    const role = isOneOf(MEMBER_ROLES, invitation.role) ? invitation.role : "viewer";
    await tx.db
      .insert(memberships)
      .values({ organizationId: tenantId, userId, role })
      .onConflictDoNothing({ target: [memberships.organizationId, memberships.userId] });
    await tx.db
      .update(invitations)
      .set({ status: "accepted", acceptedBy: userId, acceptedAt: now })
      .where(eq(invitations.id, invitation.id));
    await recordAudit(tx, actor, {
      action: "member.joined",
      target: { type: "user", id: userId },
      details: { role, via: "invitation", invitationId: invitation.id },
    });
    return { tenantId, userId };
  });
}

/**
 * A signed-in user accepts an invitation. The email must be theirs; for a Google-only invitation it
 * must also be verified (by Google, or by whoever created the user), because the link alone doesn't
 * prove who opened it.
 */
export async function acceptInvitation(
  db: Db,
  token: string,
  user: { id: string; email: string; emailVerified: boolean },
  actor: AuditActor,
  now: Date,
): Promise<{ tenantId: string }> {
  return consume(db, token, now, async (_tx, invitation) => {
    if (invitation.email !== user.email.toLowerCase()) {
      throw new MemberError("email_mismatch", `This invitation is for ${invitation.email}`);
    }
    if (invitation.acceptWith === "google" && !user.emailVerified) {
      throw new MemberError("email_not_verified", "Sign in with Google as this email to accept the invitation");
    }
    return { userId: user.id, actor };
  });
}

/**
 * Accepts an invitation that allows a password by creating the user with one. The link is the only
 * proof here, so the email stays unverified: Google can't later sign in to this user implicitly
 * (see src/auth.ts); they link Google themselves, signed in.
 */
export async function acceptInvitationWithPassword(
  db: Db,
  token: string,
  input: { name: string; password: string },
  actor: Omit<AuditActor, "type" | "id" | "label">,
  now: Date,
): Promise<{ tenantId: string; email: string }> {
  let email = "";
  const result = await consume(db, token, now, async (tx, invitation) => {
    if (invitation.acceptWith !== "google_or_password") {
      throw new MemberError("password_not_allowed", "This invitation must be accepted with Google");
    }
    email = invitation.email;
    const [existing] = await tx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new MemberError("user_exists", "That email already has an account: sign in, then accept");
    const [user] = await tx.db
      .insert(users)
      .values({ email, name: input.name.trim() || email, emailVerified: false })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert returned nothing");
    await tx.db.insert(accounts).values({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(input.password),
    });
    return { userId: user.id, actor: { type: "user", id: user.id, label: email, ...actor } };
  });
  return { tenantId: result.tenantId, email };
}

/** Points a session at a tenant (after accepting an invitation, the session acts in that tenant). */
export async function setSessionTenant(db: Db, sessionToken: string, tenantId: string): Promise<void> {
  await db.update(sessions).set({ activeOrganizationId: tenantId }).where(eq(sessions.token, sessionToken));
}
