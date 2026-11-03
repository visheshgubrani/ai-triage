import { INVITATION_ACCEPT_METHODS, INVITATION_STATUSES, JOIN_ROLES } from "@ai-triage/core";
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_helpers";

// Better Auth tables (better-auth 1.7, core + organization and twoFactor plugins), renamed through `modelName`
// in src/auth.ts. The drizzle adapter looks tables up by these export names and columns by their
// property names, so keep both in sync with Better Auth's field names.
//
// These are global tables: a user can belong to several tenants, and Better Auth reads them before
// any tenant is known. They have no RLS and keep Better Auth's `organization_id` naming, so "has a
// `tenant_id` column" means exactly "is an RLS tenant table". Membership checks go through
// getMembership() in src/tenants.ts.

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Better Auth "organization". The root of tenant isolation. `workspace_domain`: a Google Workspace
 * domain whose people may join on their first Google sign-in, as `workspace_join_role`. An admin
 * claims it by signing in to a Google account in that domain; one tenant per domain.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    metadata: text("metadata"),
    workspaceDomain: text("workspace_domain").unique("tenants_workspace_domain_key"),
    workspaceJoinRole: text("workspace_join_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    oneOf("tenants_workspace_join_role_check", t.workspaceJoinRole, JOIN_ROLES),
    check(
      "tenants_workspace_domain_check",
      sql`(${t.workspaceDomain} is null) = (${t.workspaceJoinRole} is null) and ${t.workspaceDomain} = lower(${t.workspaceDomain})`,
    ),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** twoFactor plugin. */
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  /**
   * The Google Workspace domain (`hd` claim) of the account the user signed up with, if any. Set
   * once, by Sign in with Google (src/auth.ts); it decides Workspace domain auto-join.
   */
  hostedDomain: text("hosted_domain"),
  ...timestamps,
});

/** twoFactor plugin: a user's TOTP secret (encrypted by Better Auth) and backup codes. */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factors_user_id_idx").on(t.userId), index("two_factors_secret_idx").on(t.secret)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: uuid("active_organization_id").references(() => tenants.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    unique("accounts_provider_id_account_id_key").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/** Better Auth "member". `role` is one of MEMBER_ROLES (validated in src/auth.ts access control). */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_organization_id_user_id_key").on(t.organizationId, t.userId),
    index("memberships_user_id_idx").on(t.userId),
  ],
);

/**
 * Better Auth "invitation", written only by the app's own invitation flow (src/members.ts): Better
 * Auth's organization endpoints aren't mounted. The link carries a random token; only its SHA-256 is
 * stored. `inviter_id` is null for invitations made by the CLI (`pnpm tenant:create`).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Lowercase. */
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").unique("invitations_token_hash_key"),
    acceptWith: text("accept_with").notNull().default("google"),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invitations_organization_id_idx").on(t.organizationId),
    index("invitations_email_idx").on(t.email),
    oneOf("invitations_status_check", t.status, INVITATION_STATUSES),
    oneOf("invitations_accept_with_check", t.acceptWith, INVITATION_ACCEPT_METHODS),
  ],
);
