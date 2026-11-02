import type { DocumentDetail, DocumentList, DocumentSummary, SourceUrlResponse } from "@ai-triage/contracts";
import { getDocumentDetail, listDocuments, withTenantTx } from "@ai-triage/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../deps";
import { requireTenant, type TenantEnv } from "../tenant";

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

function detail(d: NonNullable<Awaited<ReturnType<typeof getDocumentDetail>>>): DocumentDetail {
  const { document: doc, run, extraction, task } = d;
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
      status: run.status,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    parts: d.parts.map(({ partIndex, kind, mime, label, page, text, evidenceMode }) => ({
      partIndex,
      kind,
      mime,
      label,
      page,
      text,
      evidenceMode,
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
      category: extraction.category,
      fields: extraction.fields,
      validationErrors: extraction.validationErrors,
      gateResults: extraction.gateResults,
      score: extraction.score,
      decision: extraction.decision,
      decisionReasons: extraction.decisionReasons,
    },
    task: task && { id: task.id, kind: task.kind, status: task.status, reasons: task.reasons },
    actions: d.actions.map((a) => ({
      id: a.id,
      status: a.status,
      payload: a.payload,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/** Read-only document views for any member of the tenant. */
export const documentRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps.db, deps.auth))
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
      return c.json(detail(found), 200);
    })
    .get("/:id/source", idParam, async (c) => {
      const found = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        getDocumentDetail(tx, c.req.valid("param").id),
      );
      if (!found) return c.json({ error: "Not found" }, 404);
      const body: SourceUrlResponse = {
        url: await deps.storage.presignGet(found.document.sourceKey, 300, found.document.title),
      };
      return c.json(body, 200);
    });
