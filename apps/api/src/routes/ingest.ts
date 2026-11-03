import { createHash, timingSafeEqual } from "node:crypto";
import type { IgnoredResponse, IngestResponse } from "@ai-triage/contracts";
import type { PostmarkInbound } from "@ai-triage/core/pipeline";
import { ingestFile, ingestPostmark } from "@ai-triage/ingest";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiKeyEnv, requireApiKey } from "../apikey";
import type { AppDeps } from "../deps";
import { validate } from "../validate";

/** Room for base64 (Postmark) or multipart framing around a maximum-size file. */
const limit = (deps: AppDeps) =>
  bodyLimit({
    maxSize: Math.ceil(deps.limits.maxFileBytes * 1.4) + 2 ** 20,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });

/** Constant-time string comparison (hashing first makes the lengths equal). */
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * Postmark inbound webhook. Postmark doesn't sign webhooks, so the URL carries basic-auth
 * credentials (over HTTPS). The tenant comes from the recipient address. Always 200 for a handled
 * payload, including duplicates and unknown recipients, so Postmark doesn't retry them.
 */
export const webhookRoutes = (deps: AppDeps) =>
  new Hono().post(
    "/postmark",
    basicAuth({
      // Both comparisons always run, so timing doesn't reveal which one failed.
      verifyUser: (user, password) =>
        deps.postmark !== null &&
        [sameSecret(user, deps.postmark.user), sameSecret(password, deps.postmark.password)].every(Boolean),
    }),
    limit(deps),
    async (c, next) => {
      // Hono's json validator treats any other content type as an empty object.
      if (!c.req.header("content-type")?.startsWith("application/json")) {
        return c.json({ error: "Expected application/json" }, 415);
      }
      await next();
    },
    validate("json", z.looseObject({})),
    async (c) => {
      const result = await ingestPostmark(deps, c.req.valid("json") as PostmarkInbound);
      if ("ignored" in result) {
        console.warn("postmark: no tenant for the recipients of this message; ignored");
        const body: IgnoredResponse = result;
        return c.json(body, 200);
      }
      const body: IngestResponse = result;
      return c.json(body, 200);
    },
  );

/** Public REST API, authenticated with a tenant API key. */
export const publicApiRoutes = (deps: AppDeps) =>
  new Hono<ApiKeyEnv>()
    .use(requireApiKey(deps.db, deps.pool))
    .post("/documents", limit(deps), validate("form", z.object({ file: z.instanceof(File) })), async (c) => {
      const { file } = c.req.valid("form");
      const result: IngestResponse = await ingestFile(
        deps,
        c.var.apiKey.tenantId,
        {
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name || null,
          mime: file.type || null,
          source: "api",
        },
        deps.limits,
      );
      return c.json(result, result.duplicate ? 200 : 201);
    });
