import type { AuditAction } from "@ai-triage/core";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getIP } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/organization/access";
import { asc, eq } from "drizzle-orm";
import { admissionRefusal } from "./admission";
import { recordUserAudit } from "./audit";
import { oauthTwoFactor } from "./auth-oauth-2fa";
import type { Db } from "./index";
import * as schema from "./schema";

// Better Auth with organizations as tenants (docs/architecture.md §3). It lives in packages/db
// because its drizzle adapter imports drizzle-orm, and only this package may (AGENTS.md).
//
// Tenants are created only by createTenant() (seed/admin tooling), so users can't create
// organizations, and public sign-up is off. Roles are admin / reviewer / viewer; Better Auth's
// access control only governs its own org endpoints (members, invitations), and the API
// enforces app permissions with requireRole().

const ac = createAccessControl(defaultStatements);
const roles = {
  admin: ac.newRole({ ...adminAc.statements }),
  reviewer: ac.newRole({}),
  viewer: ac.newRole({}),
};

export interface AuthOptions {
  db: Db;
  secret: string;
  /** Public URL of the API, where /api/auth/* is mounted. */
  baseURL: string;
  /** The web app: the only origin allowed to call the auth endpoints, and where OAuth returns to. */
  webOrigin: string;
  /** Proxies whose X-Forwarded-For is believed (TRUSTED_PROXIES), for session IPs. */
  trustedProxies?: string[];
  /** Sign in with Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET); absent or null keeps it off. */
  google?: { clientId: string; clientSecret: string } | null;
}

/** The provider id Better Auth gives Google accounts (`accounts.provider_id`). */
export const GOOGLE_PROVIDER_ID = "google";

export function createAuth({ db, secret, baseURL, webOrigin, trustedProxies = [], google = null }: AuthOptions) {
  // Linking or unlinking Google is an account-level change, audited in each of the user's tenants.
  const auditAccount = async (
    action: AuditAction,
    account: { userId: string; providerId: string },
    ctx: { request?: Request; headers?: Headers } | null | undefined,
  ) => {
    if (account.providerId !== GOOGLE_PROVIDER_ID) return;
    const [user] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, account.userId));
    const headers = ctx?.request?.headers ?? ctx?.headers;
    const actor = {
      type: "user" as const,
      id: account.userId,
      label: user?.email ?? null,
      ip: headers ? getIP(headers, options) : null,
      userAgent: headers?.get("user-agent") ?? null,
    };
    await recordUserAudit(db.$client, account.userId, actor, { action, target: { type: "user", id: account.userId } });
  };

  const options = {
    appName: "AI Triage",
    secret,
    baseURL,
    trustedOrigins: [webOrigin],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // OAuth errors (for example `not_invited`) land on the web's sign-in page, which explains them.
    onAPIError: { errorURL: `${webOrigin}/sign-in` },
    // The adapter finds tables by these export names in ./schema.
    user: {
      modelName: "users",
      // Filled from Google's `hd` claim by mapProfileToUser below. Better Auth drops provider fields
      // marked `input: false`, so this one is an input; the endpoints that could set it from a request
      // body (sign-up, update-user) aren't mounted (apps/api/src/auth-routes.ts).
      additionalFields: { hostedDomain: { type: "string", required: false } },
    },
    account: {
      modelName: "accounts",
      // A Google sign-in joins an existing user with the same email only when Google verified the
      // email and so did we (requireLocalEmailVerified, Better Auth's default). Google isn't a
      // "trusted provider", which would skip the first check. A user who accepted an invitation with
      // a password isn't verified, so Google can't take that account over; they link Google from
      // Settings → Security instead, while signed in.
      accountLinking: { enabled: true, allowDifferentEmails: false },
    },
    verification: { modelName: "verifications" },
    ...(google
      ? {
          socialProviders: {
            google: {
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              prompt: "select_account" as const,
              // Sign-in needs the identity only: no refresh token, and the tokens aren't stored.
              accessType: "online" as const,
              mapProfileToUser: (profile: { hd?: string }) => ({ hostedDomain: profile.hd?.toLowerCase() ?? null }),
            },
          },
        }
      : {}),
    advanced: {
      // Leave id out of inserts so Postgres fills uuid defaults; tenant_id columns are uuid.
      database: { generateId: "uuid" },
      // Secure cookies whenever the API is served over https, whatever NODE_ENV says.
      useSecureCookies: baseURL.startsWith("https://"),
      ipAddress: { trustedProxies },
    },
    // The api rate-limits /api/auth itself, in Postgres and keyed on the trusted client IP
    // (apps/api/src/rate-limit.ts). Better Auth's limiter is per process, and without a proxy header
    // it would put every client in one bucket.
    rateLimit: { enabled: false },
    // Sliding 7-day sessions, refreshed at most daily (Better Auth's defaults, stated on purpose).
    session: { modelName: "sessions", expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    databaseHooks: {
      user: {
        create: {
          // The only way a user is created through Better Auth is a Google sign-in (email sign-up is
          // off), and it must be expected: see admission.ts. The code reaches the sign-in page as `?error=`.
          before: async (user: { email: string; emailVerified: boolean; hostedDomain?: string | null }) => {
            const refusal = await admissionRefusal(db, {
              email: user.email.toLowerCase(),
              emailVerified: user.emailVerified,
              hostedDomain: user.hostedDomain ?? null,
            });
            if (refusal) throw new APIError("FORBIDDEN", { code: refusal, message: "Not invited to any workspace" });
          },
        },
      },
      account: {
        // Google's tokens aren't needed after sign-in (mailbox access has its own, per tenant), so
        // they're never stored.
        create: {
          before: async (account: { providerId: string }) =>
            account.providerId === GOOGLE_PROVIDER_ID
              ? { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
              : undefined,
          after: async (account: { userId: string; providerId: string }, ctx) =>
            auditAccount("auth.google_linked", account, ctx),
        },
        update: {
          before: async (account: { providerId?: string }) =>
            account.providerId === GOOGLE_PROVIDER_ID
              ? { data: { ...account, accessToken: null, refreshToken: null, idToken: null } }
              : undefined,
        },
        delete: {
          after: async (account: { userId: string; providerId: string }, ctx) =>
            auditAccount("auth.google_unlinked", account, ctx),
        },
      },
      session: {
        create: {
          // Sign-in lands in the user's first tenant.
          before: async (session) => {
            const [first] = await db
              .select({ tenantId: schema.memberships.organizationId })
              .from(schema.memberships)
              .where(eq(schema.memberships.userId, session.userId))
              .orderBy(asc(schema.memberships.createdAt))
              .limit(1);
            return { data: { ...session, activeOrganizationId: first?.tenantId ?? null } };
          },
        },
      },
    },
    plugins: [
      // TOTP with backup codes (docs/security.md, M6). Better Auth encrypts the TOTP secret with
      // BETTER_AUTH_SECRET; the api requires it for admin-only routes when REQUIRE_ADMIN_2FA is on.
      // Passwordless: a Google-only user has no password to confirm with, so the api asks for a recent
      // sign-in instead (apps/api/src/auth-routes.ts).
      twoFactor({
        issuer: "AI Triage",
        allowPasswordless: true,
        schema: { twoFactor: { modelName: "twoFactors" } },
      }),
      // A Google sign-in asks for the TOTP code too.
      oauthTwoFactor({ pendingURL: `${webOrigin}/sign-in?step=two-factor` }),
      organization({
        ac,
        roles,
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        schema: {
          organization: { modelName: "tenants" },
          member: { modelName: "memberships" },
          invitation: { modelName: "invitations" },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
