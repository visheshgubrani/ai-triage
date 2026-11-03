import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// `recorded.json` in the cassette directory says which models have a complete cassette set for the
// fixtures, keyed by model ref. The replay end-to-end tests and the eval seed run a model only once
// its set is recorded; before that, every request would miss its cassette.

export interface RecordedSet {
  recordedAt: string;
  /** The effort both stages were recorded at (absent: the recorder's default, low). */
  effort?: string;
  fixtures: number;
  liveCalls: number;
  spentUsd: number;
}

const recordedPath = (dir: string) => join(dir, "recorded.json");

/** The recorded sets by model ref (empty if nothing has been recorded). */
export function readRecorded(dir: string): Record<string, RecordedSet> {
  const path = recordedPath(dir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, RecordedSet>;
}

export const isRecorded = (dir: string, model: string): boolean => model in readRecorded(dir);

/** Marks `model`'s set as recorded, keeping the other models' entries. */
export async function markRecorded(dir: string, model: string, set: RecordedSet): Promise<void> {
  const all = { ...readRecorded(dir), [model]: set };
  await writeFile(recordedPath(dir), `${JSON.stringify(all, null, 2)}\n`);
}
