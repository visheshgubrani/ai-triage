import type { AuthProvidersResponse, ErrorResponse, HealthResponse, Issue, MeResponse } from "@ai-triage/contracts";
import { PipelineError } from "@ai-triage/core/pipeline";
import { ConfigError, EvalRequestError, getTenant, MemberError, pingDb, ReviewError } from "@ai-triage/db";
import { IngestRejected } from "@ai-triage/ingest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { handleAuth } from "./auth-routes";
import type { AppDeps } from "./deps";
import { EVAL_ERROR_STATUS } from "./evals";
import { REVIEW_ERROR_STATUS } from "./review";
import { actionRoutes } from "./routes/actions";
import { configRoutes } from "./routes/configs";
import { documentRoutes } from "./routes/documents";
import { evalRoutes } from "./routes/evals";
import { publicApiRoutes, webhookRoutes } from "./routes/ingest";
import { integrationRoutes, mailboxRoutes } from "./routes/mailboxes";
import { invitationRoutes, MEMBER_ERROR_STATUS, memberRoutes } from "./routes/members";
import { reviewRoutes } from "./routes/review";
import { settingsRoutes } from "./routes/settings";
import { uploadRoutes } from "./routes/uploads";
import { apiSecureHeaders, limitJsonBodies, requestLog, requireTrustedOrigin } from "./security";
import { requireTenant } from "./tenant";

export type { AppDeps } from "./deps";

/** Builds the API. Dependencies are injected so tests can run it against a scratch database. */
export function createApp(deps: AppDeps) {
  const { db, webOrigin } = deps;
  const app = new Hono();
  app.use(requestId());
  if (process.env.NODE_ENV !== "test") app.use(requestLog());

  app.onError((err, c) => {
    if (err instanceof IngestRejected) return c.json({ error: err.message }, err.status);
    // A file that can't be read as what it claims to be (for example, a malformed .eml). The
    // parser's own message stays in the log: it can quote library internals.
    if (err instanceof PipelineError) {
      console.warn(`req=${c.get("requestId")} unreadable file (${err.reason}): ${err.message}`);
      const body: ErrorResponse = {
        error: "The file couldn't be read",
        code: "unreadable_file",
        details: { reason: err.reason },
      };
      return c.json(body, 422);
    }
    if (err instanceof ReviewError) {
      const { issues, ...details } = err.details as { issues?: Issue[] };
      const body: ErrorResponse = { error: err.message, code: err.code, issues, details };
      return c.json(body, REVIEW_ERROR_STATUS[err.code]);
    }
    if (err instanceof MemberError) {
      const body: ErrorResponse = { error: err.message, code: err.code };
      return c.json(body, MEMBER_ERROR_STATUS[err.code]);
    }
    if (err instanceof EvalRequestError) {
      const body: ErrorResponse = { error: err.message, code: err.code, details: err.details };
      return c.json(body, EVAL_ERROR_STATUS[err.code]);
    }
    // A candidate config the catalog refuses (unknown model, an effort it doesn't accept, …).
    if (err instanceof ConfigError) {
      const body: ErrorResponse = { error: err.message, code: "invalid_config" };
      return c.json(body, 422);
    }
    if (err instanceof HTTPException) return err.getResponse();
    const id = c.get("requestId");
    console.error(`req=${id}`, err);
    const body: ErrorResponse = { error: "Internal error", requestId: id };
    return c.json(body, 500);
  });

  return (
    app
      .use("*", apiSecureHeaders({ hsts: deps.hsts }))
      // CORS must be registered before the auth routes so their responses carry the headers.
      .use("*", cors({ origin: webOrigin, credentials: true }))
      .use("*", requireTrustedOrigin([webOrigin]))
      .use("*", limitJsonBodies())
      .on(["GET", "POST"], "/api/auth/*", (c) => handleAuth(c, deps))
      .get("/health", async (c) => {
        const dbUp = await pingDb(db);
        const body: HealthResponse = {
          status: dbUp ? "ok" : "degraded",
          db: dbUp ? "up" : "down",
          time: new Date().toISOString(),
        };
        return c.json(body, dbUp ? 200 : 503);
      })
      // Public: the sign-in page shows "Continue with Google" only when the instance has a client.
      .get("/auth/providers", (c) => {
        const body: AuthProvidersResponse = { google: deps.googleSignIn };
        return c.json(body, 200);
      })
      .get("/me", requireTenant(deps), async (c) => {
        const { tenantId, role, user, twoFactorEnabled, twoFactorRequired } = c.var.tenant;
        const tenant = await getTenant(db, tenantId);
        if (!tenant) return c.json({ error: "Tenant not found" }, 404);
        const body: MeResponse = { user, tenant, role, twoFactorEnabled, twoFactorRequired };
        return c.json(body, 200);
      })
      .route("/uploads", uploadRoutes(deps))
      .route("/documents", documentRoutes(deps))
      .route("/review", reviewRoutes(deps))
      .route("/actions", actionRoutes(deps))
      .route("/settings", settingsRoutes(deps))
      .route("/members", memberRoutes(deps))
      .route("/invitations", invitationRoutes(deps))
      .route("/mailboxes", mailboxRoutes(deps))
      .route("/integrations", integrationRoutes(deps))
      .route("/evals", evalRoutes(deps))
      .route("/configs", configRoutes(deps))
      .route("/webhooks", webhookRoutes(deps))
      .route("/v1", publicApiRoutes(deps))
  );
}

export type AppType = ReturnType<typeof createApp>;
