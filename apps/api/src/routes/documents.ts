import type {
  DocumentDetail,
  DocumentList,
  DocumentSummary,
  EmailView,
  FileUrlResponse,
  SourceUrlResponse,
} from "@ai-triage/contracts";
import { EMAIL_SOURCE_MIME } from "@ai-triage/core";
import {
  getDocumentDetail,
  listDocuments,
  loadDocument,
  loadPart,
  purgeDocument,
  recordAudit,
  withTenantTx,
} from "@ai-triage/db";
import { readEmailView } from "@ai-triage/ingest";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";

/** A malformed id is just a document that doesn't exist. */
export const idParam = zValidator("param", z.object({ id: z.uuid() }), (result, c) => {
  if (!result.success) return c.json({ error: "Not found" }, 404);
});

type ListRow = Awaited<ReturnType<typeof listDocuments>>[number];

function summary(row: ListRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    mime: row.mime,
    createdAt: row.createdAt.toISOString(),
    processingStatus: row.processingStatus,
    reviewStatus: row.reviewStatus,
    deliveryStatus: row.deliveryStatus,
    category: row.category,
    score: row.score,
    decision: row.decision,
    reasons: row.taskReasons ?? row.decisionReasons ?? [],
    taskKind: row.taskKind,
  };
}

function detail(d: NonNullable<Awaited<ReturnType<typeof getDocumentDetail>>>, now: Date): DocumentDetail {
  const { document: doc, run, extraction, task } = d;
  // Pages of one PDF share a stored file; the UI opens it once, by its first part's index.
  const fileIndex = new Map<string, number>();
  for (const p of d.parts) if (p.storageKey && !fileIndex.has(p.storageKey)) fileIndex.set(p.storageKey, p.partIndex);
  const liveClaim =
    task?.status === "claimed" && task.claimedBy && task.leaseExpiresAt && task.leaseExpiresAt > now
      ? { userId: task.claimedBy, email: task.claimedByEmail, leaseExpiresAt: task.leaseExpiresAt.toISOString() }
      : null;
  return {
    document: {
      id: doc.id,
      title: doc.title,
      source: doc.source,
      mime: doc.mime,
      sizeBytes: doc.sizeBytes,
      createdAt: doc.createdAt.toISOString(),
      processingStatus: doc.processingStatus,
      reviewStatus: doc.reviewStatus,
      deliveryStatus: doc.deliveryStatus,
      category: extraction?.category ?? d.classification?.category ?? null,
      score: extraction?.score ?? d.classification?.selfConfidence ?? null,
      decision: extraction?.decision ?? null,
      reasons: task?.reasons ?? extraction?.decisionReasons ?? [],
      taskKind: task?.kind ?? null,
    },
    run: run && {
      id: run.id,
      trigger: run.trigger,
      forcedCategory: run.forcedCategory,
      status: run.status,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    parts: d.parts.map(({ partIndex, kind, mime, label, page, text, evidenceMode, storageKey }) => ({
      partIndex,
      kind,
      mime,
      label,
      page,
      text,
      evidenceMode,
      fileIndex: storageKey ? (fileIndex.get(storageKey) ?? null) : null,
    })),
    classification: d.classification && {
      category: d.classification.category,
      selfConfidence: d.classification.selfConfidence,
      rationale: d.classification.rationale,
    },
    extraction: extraction && {
      id: extraction.id,
      revision: extraction.revision,
      author: extraction.author,
      parentId: extraction.parentId,
      category: extraction.category,
      schemaVersionId: extraction.schemaVersionId,
      fields: extraction.fields,
      validationErrors: extraction.validationErrors,
      gateResults: extraction.gateResults,
      score: extraction.score,
      decision: extraction.decision,
      decisionReasons: extraction.decisionReasons,
      createdAt: extraction.createdAt.toISOString(),
    },
    schema: d.schema ?? null,
    modelGateResults: d.modelGateResults,
    revisions: d.revisions.map((r) => ({
      id: r.id,
      revision: r.revision,
      author: r.author,
      authorEmail: r.authorEmail,
      category: r.category,
      decision: r.decision,
      createdAt: r.createdAt.toISOString(),
    })),
    task: task && {
      id: task.id,
      kind: task.kind,
      // A lapsed claim is no claim.
      status: task.status === "claimed" && !liveClaim ? "pending" : task.status,
      reasons: task.reasons,
      extractionId: task.extractionId,
      createdAt: task.createdAt.toISOString(),
      claim: liveClaim,
    },
    decisions: d.decisions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    actions: d.actions.map((a) => ({
      id: a.id,
      extractionId: a.extractionId,
      status: a.status,
      payload: a.payload,
      attempts: a.attempts,
      lastError: a.lastError,
      deliveredAt: a.deliveredAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
    categories: d.categories,
  };
}

const partParam = zValidator("param", z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }), (r, c) => {
  if (!r.success) return c.json({ error: "Not found" }, 404);
});

/** Document views for any member of the tenant, including the sources the review page shows. */
export const documentRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/", async (c) => {
      const rows = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => listDocuments(tx, { limit: 100 }));
      const body: DocumentList = { documents: rows.map(summary) };
      return c.json(body, 200);
    })
    .get("/:id", idParam, async (c) => {
      const found = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        getDocumentDetail(tx, c.req.valid("param").id),
      );
      if (!found) return c.json({ error: "Not found" }, 404);
      return c.json(detail(found, deps.now()), 200);
    })
    // Deletes the document and everything derived from it (docs/security.md, privacy). Admins only;
    // the audit event keeps the id and a hash of the external id, never content.
    .delete("/:id", requireRole("admin"), idParam, async (c) => {
      const id = c.req.valid("param").id;
      const purged = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const done = await purgeDocument(tx, deps.boss, id);
        if (done) {
          await recordAudit(tx, userActor(c, deps), {
            action: "document.purged",
            target: { type: "document", id },
            details: done,
          });
        }
        return done;
      });
      if (!purged) return c.json({ error: "Not found" }, 404);
      return c.json({ deleted: true }, 200);
    })
    .get("/:id/source", idParam, async (c) => {
      const document = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        loadDocument(tx, c.req.valid("param").id),
      );
      if (!document) return c.json({ error: "Not found" }, 404);
      const body: SourceUrlResponse = {
        url: await deps.storage.presignGet(document.sourceKey, 300, { mime: document.mime, filename: document.title }),
      };
      return c.json(body, 200);
    })
    .get("/:id/email", idParam, async (c) => {
      const document = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        loadDocument(tx, c.req.valid("param").id),
      );
      if (!document || document.mime !== EMAIL_SOURCE_MIME) return c.json({ error: "Not found" }, 404);
      const body: EmailView = await readEmailView(deps.storage, document.sourceKey);
      return c.json(body, 200);
    })
    .get("/:id/parts/:index/file", partParam, async (c) => {
      const { id, index } = c.req.valid("param");
      const part = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => loadPart(tx, id, index));
      if (!part?.storageKey) return c.json({ error: "Not found" }, 404);
      const body: FileUrlResponse = {
        url: await deps.storage.presignGet(part.storageKey, 300, { mime: part.mime, filename: part.label }),
        mime: part.mime,
        label: part.label,
      };
      return c.json(body, 200);
    });
