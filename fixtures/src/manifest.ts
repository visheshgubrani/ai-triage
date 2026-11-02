import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentSource, EvalSplit } from "@ai-triage/core";

// The labeled synthetic documents in fixtures/docs, described by fixtures/manifest.json. The demo
// seed ingests them, the replay e2e test asserts on them, the recorder records cassettes for them,
// and phase 4 turns them into the labeled eval dataset (with these splits).

export const FIXTURE_FORMATS = ["postmark", "eml", "pdf", "docx", "png", "txt"] as const;
export type FixtureFormat = (typeof FIXTURE_FORMATS)[number];

export const FIXTURE_TAGS = [
  /** Unambiguous, fully legible, every required field stated: should auto-approve where automation is on. */
  "clear",
  /** Hard to classify or extract on purpose (a quote, a dispute, a draft, totals that don't add up...). */
  "ambiguous",
  /** No text layer (image-only PDF or image): can't be verified, so it must go to review. */
  "scan",
  /** Contains text trying to steer the model: must never auto-approve. */
  "injection",
] as const;
export type FixtureTag = (typeof FIXTURE_TAGS)[number];

export interface FixtureItem {
  id: string;
  /** The ingestion path: `email` (Postmark webhook), `api` (REST) or `upload` (two-step upload). */
  source: DocumentSource;
  format: FixtureFormat;
  /** Path relative to the fixtures directory. */
  file: string;
  mime: string;
  filename: string;
  expectedCategory: string;
  /** Ground truth for the category's fields (only those the document states). */
  expectedFields: Record<string, unknown>;
  tags: FixtureTag[];
  split: EvalSplit;
  /** One line on what the item is for. */
  note: string;
}

export interface FixtureManifest {
  version: 1;
  /** Inbound address the email fixtures are addressed to (the demo tenant's). */
  inboundAddress: string;
  items: FixtureItem[];
}

export async function loadManifest(fixturesDir: string): Promise<FixtureManifest> {
  return JSON.parse(await readFile(join(fixturesDir, "manifest.json"), "utf8")) as FixtureManifest;
}

export async function readFixture(fixturesDir: string, item: FixtureItem): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixturesDir, item.file)));
}
