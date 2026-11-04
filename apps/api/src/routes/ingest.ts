import {
  type IgnoredResponse,
  type IngestResponse,
  type PublicCategoryList,
  type PublicDocument,
  type PublicDocumentList,
  PublicDocumentQuery,
  PublicIngestForm,
} from "@ai-triage/contracts";
import { documentState } from "@ai-triage/core";
import { normalizePostmark, type PostmarkInbound } from "@ai-triage/core/pipeline";
import {
  findDocumentsByExternalRef,
  getActiveConfig,
  getDocumentDetail,
  type TenantTx,
  withTenantTx,
} from "@ai-triage/db";
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
import { type ApiKeyEnv, requireApiKey, requireScope } from "../apikey";
import type { AppDeps } from "../deps";
import { log } from "../log";
import { overLimit } from "../rate-limit";
import { sameSecret } from "../security";
import { validate } from "../validate";
import { categoryInfos } from "./categories";
import { idParam } from "./documents";

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
        log.warn("postmark: refused a message", { message: err.message });
        return c.json({ error: err.message }, 403);
      }
      const tenantId = await resolveEmailTenant(deps.pool, email.recipients);
      if (!tenantId) {
        log.warn("postmark: no tenant for the recipients of this message; ignored");
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

/** A document as the public API reports it, or null if it isn't the tenant's. */
async function publicDocument(tx: TenantTx, documentId: string): Promise<PublicDocument | null> {
  const detail = await getDocumentDetail(tx, documentId);
  if (!detail) return null;
  const { document: d, extraction, run, task } = detail;
  const failure = d.processingStatus === "failed" ? (run?.error?.split(":")[0] ?? "failed") : null;
  return {
    id: d.id,
    external_ref: d.externalRef,
    created_at: d.createdAt.toISOString(),
    state: documentState(d),
    processing_status: d.processingStatus,
    review_status: d.reviewStatus,
    delivery_status: d.deliveryStatus,
    category: extraction?.category ?? null,
    fields: (extraction?.fields as Record<string, unknown> | undefined) ?? null,
    reasons: failure
      ? [failure]
      : run?.skipReason
        ? [run.skipReason]
        : (task?.reasons ?? extraction?.decisionReasons ?? []),
    delivered_at: detail.actions.findLast((x) => x.deliveredAt)?.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * Public REST API, authenticated with a tenant API key (docs/api.md). `ingest` sends documents in;
 * `read` looks them up, so a sender can see what happened to one without waiting for a webhook
 * (which only fires on approval).
 */
export const publicApiRoutes = (deps: AppDeps) =>
  new Hono<ApiKeyEnv>()
    .use(requireApiKey(deps.db, deps.pool))
    .use(async (c, next) => {
      const limited = await overLimit(c, deps, deps.rateLimits.apiPerKey, `api_key:${c.var.apiKey.keyId}`);
      if (limited) return limited;
      await next();
    })
    .post("/documents", requireScope("ingest"), limit(deps), validate("form", PublicIngestForm), async (c) => {
      const { file, external_ref } = c.req.valid("form");
      const result: IngestResponse = await ingestFile(
        deps,
        c.var.apiKey.tenantId,
        {
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name || null,
          mime: file.type || null,
          source: "api",
          externalRef: external_ref ?? null,
        },
        deps.limits,
      );
      return c.json(result, result.duplicate ? 200 : 201);
    })
    .get("/documents/:id", requireScope("read"), idParam, async (c) => {
      const body = await withTenantTx(deps.pool, c.var.apiKey.tenantId, (tx) =>
        publicDocument(tx, c.req.valid("param").id),
      );
      if (!body) return c.json({ error: "Not found" }, 404);
      return c.json(body, 200);
    })
    // Lookup by the sender's own reference: newest first, normally one.
    .get("/documents", requireScope("read"), validate("query", PublicDocumentQuery), async (c) => {
      const { external_ref } = c.req.valid("query");
      const body = await withTenantTx(deps.pool, c.var.apiKey.tenantId, async (tx): Promise<PublicDocumentList> => {
        const documents: PublicDocument[] = [];
        for (const id of await findDocumentsByExternalRef(tx, external_ref)) {
          const doc = await publicDocument(tx, id);
          if (doc) documents.push(doc);
        }
        return { documents };
      });
      return c.json(body, 200);
    })
    .get("/categories", requireScope("read"), async (c) => {
      const body = await withTenantTx(deps.pool, c.var.apiKey.tenantId, async (tx): Promise<PublicCategoryList> => {
        const config = await getActiveConfig(tx);
        if (!config) return { categories: [] };
        const infos = await categoryInfos(tx, config);
        return {
          categories: infos.map((i) => ({
            name: i.category,
            origin: i.origin,
            version: i.version,
            description: i.description,
            json_schema: i.jsonSchema,
          })),
        };
      });
      return c.json(body, 200);
    });
