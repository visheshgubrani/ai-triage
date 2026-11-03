import type { ParsedPart } from "@ai-triage/core/pipeline";
import { buildPipelineConfig, createBoss, createPool, loadDocument, type PgBoss, withTenantTx } from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { loadManifest } from "@ai-triage/fixtures";
import { snapshotDocumentSource } from "@ai-triage/ingest";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { importFixture, ingestFixture } from "../fixtures";
import { parseSource } from "./source";

// An eval item must parse exactly as the document it mirrors, or its model requests would differ
// from production's (and miss their cassettes). Storage keys are the only allowed difference: they
// are never sent to the model.

const config = workerConfig();
const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const storage = createStorage(storageConfigFromEnv());
const manifest = await loadManifest(config.fixturesDir);
const parseLimits = { maxPdfPages: config.maxPdfPages };
let boss: PgBoss;
let tenantId: string;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  tenantId = await newTenant(pool);
  // Ingestion needs an active config (documents start a run); its models don't matter here.
  await withTenantTx(pool, tenantId, (tx) => buildPipelineConfig(tx));
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

const withoutKeys = (parts: ParsedPart[]) => parts.map(({ storageKey: _key, ...rest }) => rest);

describe("eval item sources", () => {
  it("parse like the documents they mirror, from a fixture or a document snapshot", async () => {
    for (const item of manifest.items) {
      const { documentId } = await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, {
        maxFileBytes: config.maxFileBytes,
      });
      const doc = await withTenantTx(pool, tenantId, (tx) => loadDocument(tx, documentId));
      if (!doc) throw new Error(`no document for ${item.id}`);
      const fromDocument = await parseSource(storage, doc, parseLimits);

      const imported = await importFixture(storage, tenantId, item, config.fixturesDir);
      expect(imported.contentKey, item.id).toBe(doc.externalId);
      expect([imported.sourceMime, imported.sourceTitle], item.id).toEqual([doc.mime, doc.title]);
      const fromImport = await parseSource(
        storage,
        { sourceKey: imported.sourceKey, mime: imported.sourceMime, title: imported.sourceTitle },
        parseLimits,
      );
      expect(withoutKeys(fromImport), item.id).toEqual(withoutKeys(fromDocument));

      const snapshot = await snapshotDocumentSource(storage, tenantId, doc);
      expect(snapshot.sourceKey).not.toBe(doc.sourceKey);
      const fromSnapshot = await parseSource(
        storage,
        { sourceKey: snapshot.sourceKey, mime: snapshot.sourceMime, title: snapshot.sourceTitle },
        parseLimits,
      );
      expect(withoutKeys(fromSnapshot), item.id).toEqual(withoutKeys(fromDocument));
    }
  });
});
