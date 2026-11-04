import { timingSafeEqual } from "node:crypto";
import type { IgnoredResponse, IngestResponse } from "@ai-triage/contracts";
import { normalizePostmark, type PostmarkInbound } from "@ai-triage/core/pipeline";
import {
  checkEmailLimits,
  findEmailDuplicate,
  IngestRejected,
  ingestEmail,
  ingestFile,
  resolveEmailTenant,
} from "@ai-triage/ingest";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiKeyEnv, requireApiKey } from "../apikey";
import type { AppDeps } from "../deps";
import { overLimit } from "../rate-limit";
import { validate } from "../validate";

/** Room for base64 (Postmark) or multipart framing around a maximum-size file. */
const limit = (deps: AppDeps) =>
  bodyLimit({
    maxSize: Math.ceil(deps.limits.maxFileBytes * 1.4) + 2 ** 20,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });

/**
 * Constant-time string comparison. Both sides are padded to the same length (timingSafeEqual needs
 * that), and the lengths are compared separately, so neither the content nor its length leaks
 * through timing beyond the longer side's length.
 */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  const size = Math.max(a.length, b.length);
  const padded = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc(size - buf.length)]);
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

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
      const payload = c.req.valid("json") as PostmarkInbound;
      const email = normalizePostmark(payload);
      try {
        checkEmailLimits(email, deps.limits);
      } catch (err) {
        if (!(err instanceof IngestRejected)) throw err;
        // 403 is the one status Postmark doesn't retry: this message will never fit.
        console.warn(`postmark: refused a message: ${err.message}`);
        return c.json({ error: err.message }, 403);
      }
      const tenantId = await resolveEmailTenant(deps.pool, email.recipients);
      if (!tenantId) {
        console.warn("postmark: no tenant for the recipients of this message; ignored");
        const body: IgnoredResponse = { ignored: "unknown_recipient" };
        return c.json(body, 200);
      }
      // A redelivered webhook is answered before the limit counts it, so retries can't use it up.
      const dup = await findEmailDuplicate(deps, tenantId, email, { source: "email", postmark: payload });
      if (dup) return c.json(dup satisfies IngestResponse, 200);
      // Per tenant: anyone who knows an inbound address can send to it. A 429 makes Postmark retry
      // later, so a burst is delayed rather than lost.
      const limited = await overLimit(c, deps, deps.rateLimits.postmarkPerTenant, `tenant:${tenantId}:inbound`);
      if (limited) return limited;
      const body: IngestResponse = await ingestEmail(deps, tenantId, email, { source: "email", postmark: payload });
      return c.json(body, 200);
    },
  );

/** Public REST API, authenticated with a tenant API key. */
export const publicApiRoutes = (deps: AppDeps) =>
  new Hono<ApiKeyEnv>()
    .use(requireApiKey(deps.db, deps.pool))
    .use(async (c, next) => {
      const limited = await overLimit(c, deps, deps.rateLimits.apiPerKey, `api_key:${c.var.apiKey.keyId}`);
      if (limited) return limited;
      await next();
    })
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
