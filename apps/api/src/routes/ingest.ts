import type { IgnoredResponse, IngestResponse } from "@ai-triage/contracts";
import type { PostmarkInbound } from "@ai-triage/core/pipeline";
import { ingestFile, ingestPostmark } from "@ai-triage/ingest";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiKeyEnv, requireApiKey } from "../apikey";
import type { AppDeps } from "../deps";

/** Room for base64 (Postmark) or multipart framing around a maximum-size file. */
const limit = (deps: AppDeps) =>
  bodyLimit({
    maxSize: Math.ceil(deps.limits.maxFileBytes * 1.4) + 2 ** 20,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });

/**
 * Postmark inbound webhook. Postmark doesn't sign webhooks, so the URL carries basic-auth
 * credentials (over HTTPS). The tenant comes from the recipient address. Always 200 for a handled
 * payload, including duplicates and unknown recipients, so Postmark doesn't retry them.
 */
export const webhookRoutes = (deps: AppDeps) =>
  new Hono().post(
    "/postmark",
    basicAuth({
      verifyUser: (user, password) =>
        deps.postmark !== null && user === deps.postmark.user && password === deps.postmark.password,
    }),
    limit(deps),
    zValidator("json", z.looseObject({})),
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
    .post("/documents", limit(deps), zValidator("form", z.object({ file: z.instanceof(File) })), async (c) => {
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
