import type { PostmarkInbound } from "@ai-triage/core/pipeline";
import { normalizePostmark } from "@ai-triage/core/pipeline";
import { type FixtureItem, readFixture } from "@ai-triage/fixtures";
import {
  type EvalSource,
  type IngestDeps,
  type IngestLimits,
  type IngestResult,
  importEvalSource,
  ingestEmail,
  ingestFile,
} from "@ai-triage/ingest";
import type { Storage } from "@ai-triage/storage";

/**
 * Ingests one fixture into a tenant through the real ingestion code: email fixtures as a Postmark
 * webhook would (but for the given tenant, whatever the recipient), files as the REST API or a
 * completed upload would.
 */
export async function ingestFixture(
  deps: IngestDeps,
  tenantId: string,
  item: FixtureItem,
  fixturesDir: string,
  limits: IngestLimits,
): Promise<IngestResult> {
  const bytes = await readFixture(fixturesDir, item);
  if (item.format === "postmark") {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as PostmarkInbound;
    return ingestEmail(deps, tenantId, normalizePostmark(payload), { source: "email", postmark: payload });
  }
  return ingestFile(deps, tenantId, { bytes, filename: item.filename, mime: item.mime, source: item.source }, limits);
}

/** Stores one fixture as an eval item's source, exactly as ingestFixture would store the document's. */
export async function importFixture(
  storage: Storage,
  tenantId: string,
  item: FixtureItem,
  fixturesDir: string,
): Promise<EvalSource> {
  const bytes = await readFixture(fixturesDir, item);
  if (item.format === "postmark") {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as PostmarkInbound;
    return importEvalSource(storage, tenantId, {
      kind: "email",
      email: normalizePostmark(payload),
      original: { postmark: payload },
    });
  }
  return importEvalSource(storage, tenantId, { kind: "file", bytes, filename: item.filename, mime: item.mime });
}
