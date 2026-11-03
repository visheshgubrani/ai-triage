import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/organization/access";
import { asc, eq } from "drizzle-orm";
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
  /** Origins allowed to call the auth endpoints (the web app). */
  trustedOrigins: string[];
}

export function createAuth({ db, secret, baseURL, trustedOrigins }: AuthOptions) {
  return betterAuth({
    appName: "AI Triage",
    secret,
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // The adapter finds tables by these export names in ./schema.
    user: { modelName: "users" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    advanced: {
      // Leave id out of inserts so Postgres fills uuid defaults; tenant_id columns are uuid.
      database: { generateId: "uuid" },
      // Secure cookies whenever the API is served over https, whatever NODE_ENV says.
      useSecureCookies: baseURL.startsWith("https://"),
    },
    // Sliding 7-day sessions, refreshed at most daily (Better Auth's defaults, stated on purpose).
    session: { modelName: "sessions", expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    databaseHooks: {
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
  });
}

export type Auth = ReturnType<typeof createAuth>;
