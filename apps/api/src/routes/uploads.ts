import { type IngestResponse, UploadRequest, type UploadResponse } from "@ai-triage/contracts";
import { completeUpload, createUpload } from "@ai-triage/ingest";
import { Hono } from "hono";
import type { AppDeps } from "../deps";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

/** Two-step upload (docs/architecture.md §3): presign a server-issued key, then complete. */
export const uploadRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(
      requireTenant(deps),
      requireRole("admin", "reviewer"),
      limitUserWrites(deps, deps.rateLimits.writesPerUser),
      limitUserWrites(deps, deps.rateLimits.uploadsPerUser, "uploads"),
    )
    .post("/", validate("json", UploadRequest), async (c) => {
      const { tenantId, user } = c.var.tenant;
      const upload = await createUpload(deps, tenantId, { ...c.req.valid("json"), createdBy: user.id }, deps.limits);
      const body: UploadResponse = { ...upload, expiresAt: upload.expiresAt.toISOString() };
      return c.json(body, 201);
    })
    .post("/:id/complete", idParam, async (c) => {
      const result: IngestResponse = await completeUpload(
        deps,
        c.var.tenant.tenantId,
        c.req.valid("param").id,
        deps.limits,
      );
      return c.json(result, result.duplicate ? 200 : 201);
    });
