import { predictedLabel, type ResultRow } from "./metrics";

// Run A vs run B on the same dataset and split: which items got better or worse (docs/architecture.md §8).

export type ChangeKind = "regression" | "improvement" | "changed";

export interface ItemChange {
  itemId: string;
  kind: ChangeKind;
  /** What changed, worst first: e.g. "now a wrong auto-approval", "category invoice → other". */
  notes: string[];
  a: ResultRow;
  b: ResultRow;
}

export interface RunDiff {
  shared: number;
  onlyA: number;
  onlyB: number;
  regressions: number;
  improvements: number;
  /** Regressions first, then improvements, then other changes. */
  changes: ItemChange[];
}

const wrongAuto = (r: ResultRow) => r.decision === "auto" && !r.requiredCorrect;
const describe = (r: ResultRow) => predictedLabel(r);

/** -1 when B is worse on this aspect, 1 when better, 0 when unchanged. */
const direction = (a: boolean, b: boolean) => (a === b ? 0 : b ? 1 : -1);

function compare(a: ResultRow, b: ResultRow): ItemChange | null {
  const worse: string[] = [];
  const better: string[] = [];
  const other: string[] = [];
  const note = (d: number, worseNote: string, betterNote: string) => {
    if (d < 0) worse.push(worseNote);
    if (d > 0) better.push(betterNote);
  };
  note(direction(!wrongAuto(a), !wrongAuto(b)), "now a wrong auto-approval", "no longer a wrong auto-approval");
  note(direction(!a.errorReason, !b.errorReason), `now fails (${b.errorReason})`, "no longer fails");
  note(direction(a.categoryCorrect, b.categoryCorrect), "category now wrong", "category now right");
  note(direction(a.requiredCorrect, b.requiredCorrect), "required fields now wrong", "required fields now right");
  note(direction(a.fullyCorrect, b.fullyCorrect), "some field now wrong", "every field now right");
  if (describe(a) !== describe(b)) other.push(`category ${describe(a)} → ${describe(b)}`);
  if (a.decision !== b.decision) other.push(`decision ${a.decision ?? "none"} → ${b.decision ?? "none"}`);
  if (worse.length + better.length + other.length === 0) return null;
  const kind: ChangeKind = worse.length > 0 ? "regression" : better.length > 0 ? "improvement" : "changed";
  return { itemId: a.itemId, kind, notes: [...worse, ...better, ...other], a, b };
}

const KIND_ORDER: Record<ChangeKind, number> = { regression: 0, improvement: 1, changed: 2 };

export function diffRuns(a: readonly ResultRow[], b: readonly ResultRow[]): RunDiff {
  const byItem = new Map(b.map((r) => [r.itemId, r]));
  const aItems = new Set(a.map((r) => r.itemId));
  const changes: ItemChange[] = [];
  let shared = 0;
  for (const row of a) {
    const other = byItem.get(row.itemId);
    if (!other) continue;
    shared++;
    const change = compare(row, other);
    if (change) changes.push(change);
  }
  changes.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
  return {
    shared,
    onlyA: a.length - shared,
    onlyB: b.filter((r) => !aItems.has(r.itemId)).length,
    regressions: changes.filter((c) => c.kind === "regression").length,
    improvements: changes.filter((c) => c.kind === "improvement").length,
    changes,
  };
}
