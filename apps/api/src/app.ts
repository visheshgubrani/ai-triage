import type { HealthResponse, MeResponse } from "@ai-triage/contracts";
import { type Auth, type Db, getTenant, pingDb } from "@ai-triage/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requireTenant } from "./tenant";

export interface AppDeps {
  db: Db;
  auth: Auth;
  /** The web app's origin: allowed by CORS with credentials, and trusted by Better Auth. */
  webOrigin: string;
}

/** Builds the API. Dependencies are injected so tests can run it against a scratch database. */
export function createApp({ db, auth, webOrigin }: AppDeps) {
  const app = new Hono();
  if (process.env.NODE_ENV !== "test") app.use(logger());

  return (
    app
      // CORS must be registered before the auth routes so their responses carry the headers.
      .use("*", cors({ origin: webOrigin, credentials: true }))
      .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
      .get("/health", async (c) => {
        const dbUp = await pingDb(db);
        const body: HealthResponse = {
          status: dbUp ? "ok" : "degraded",
          db: dbUp ? "up" : "down",
          time: new Date().toISOString(),
        };
        return c.json(body, dbUp ? 200 : 503);
      })
      .get("/me", requireTenant(db, auth), async (c) => {
        const { tenantId, role, user } = c.var.tenant;
        const tenant = await getTenant(db, tenantId);
        if (!tenant) return c.json({ error: "Tenant not found" }, 404);
        const body: MeResponse = { user, tenant, role };
        return c.json(body, 200);
      })
  );
}

export type AppType = ReturnType<typeof createApp>;
