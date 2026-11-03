import type { ErrorResponse, HealthResponse, Issue, MeResponse } from "@ai-triage/contracts";
import { PipelineError } from "@ai-triage/core/pipeline";
import { getTenant, pingDb, ReviewError } from "@ai-triage/db";
import { IngestRejected } from "@ai-triage/ingest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { AppDeps } from "./deps";
import { REVIEW_ERROR_STATUS } from "./review";
import { documentRoutes } from "./routes/documents";
import { publicApiRoutes, webhookRoutes } from "./routes/ingest";
import { reviewRoutes } from "./routes/review";
import { uploadRoutes } from "./routes/uploads";
import { requireTenant } from "./tenant";

export type { AppDeps } from "./deps";

/** Builds the API. Dependencies are injected so tests can run it against a scratch database. */
export function createApp(deps: AppDeps) {
  const { db, auth, webOrigin } = deps;
  const app = new Hono();
  if (process.env.NODE_ENV !== "test") app.use(logger());

  app.onError((err, c) => {
    if (err instanceof IngestRejected) return c.json({ error: err.message }, err.status);
    // A file that can't be read as what it claims to be (for example, a malformed .eml).
    if (err instanceof PipelineError) return c.json({ error: err.message }, 422);
    if (err instanceof ReviewError) {
      const { issues, ...details } = err.details as { issues?: Issue[] };
      const body: ErrorResponse = { error: err.message, code: err.code, issues, details };
      return c.json(body, REVIEW_ERROR_STATUS[err.code]);
    }
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

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
      .route("/uploads", uploadRoutes(deps))
      .route("/documents", documentRoutes(deps))
      .route("/review", reviewRoutes(deps))
      .route("/webhooks", webhookRoutes(deps))
      .route("/v1", publicApiRoutes(deps))
  );
}

export type AppType = ReturnType<typeof createApp>;
