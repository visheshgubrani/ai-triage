"use client";

import type { EvalDiffResponse, EvalRun } from "@ai-triage/contracts";
import type { Rate } from "@ai-triage/evals";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/badge";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { FrozenBadge, headClass, ms, RateText, ReplayBadge, tableClass, usd } from "../ui";

const KIND_TONE = { regression: "text-red-600", improvement: "text-emerald-600", changed: "text-neutral-500" } as const;

function RunHeader({ label, run }: { label: string; run: EvalRun }) {
  return (
    <Link
      href={`/evals/runs/${run.id}`}
      className="block rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
    >
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="font-medium">
        v{run.config.version} {run.config.name} <FrozenBadge frozen={run.config.frozen} />{" "}
        <ReplayBadge replay={run.llmMode === "replay"} />
      </div>
      <div className="text-xs text-neutral-500">
        {run.config.classifyModel} · {run.split} · {run.datasetName}
      </div>
    </Link>
  );
}

export function DiffView({ a, b }: { a: string; b: string }) {
  const [data, setData] = useState<EvalDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await browserApi.evals.diff.$get({ query: { a, b } });
      if (!res.ok) return setError((await readError(res)).error);
      setData((await res.json()) as EvalDiffResponse);
    })();
  }, [a, b]);
  if (error) return <p className="mt-6 text-sm text-red-600">{error}</p>;
  if (!data) return <p className="mt-6 text-sm text-neutral-500">Loading…</p>;
  const [sa, sb] = [data.a.summary, data.b.summary];
  const row = (label: string, pick: (s: NonNullable<typeof sa>) => Rate) => (
    <tr>
      <td>{label}</td>
      <td>{sa ? <RateText rate={pick(sa)} /> : "-"}</td>
      <td>{sb ? <RateText rate={pick(sb)} /> : "-"}</td>
    </tr>
  );
  const { diff } = data;
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Run A vs run B</h1>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <RunHeader label="A" run={data.a} />
        <RunHeader label="B" run={data.b} />
      </div>
      <Section title="Summary">
        <table className={tableClass}>
          <thead className={headClass}>
            <tr>
              <th />
              <th>A</th>
              <th>B</th>
            </tr>
          </thead>
          <tbody>
            {row("Category accuracy", (s) => s.accuracy)}
            {row("Required fields right", (s) => s.requiredCorrect)}
            {row("Auto-approved", (s) => s.autoRate)}
            {row("Auto-approval precision", (s) => s.autoPrecision)}
            <tr>
              <td>Errors</td>
              <td>{sa?.errors ?? "-"}</td>
              <td>{sb?.errors ?? "-"}</td>
            </tr>
            <tr>
              <td>Cost / item · latency p50</td>
              <td>
                {usd(sa?.perItemUsd)} · {ms(sa?.latencyP50Ms)}
              </td>
              <td>
                {usd(sb?.perItemUsd)} · {ms(sb?.latencyP50Ms)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-neutral-500">
          {diff.shared} items in both runs ({diff.onlyA} only in A, {diff.onlyB} only in B): {diff.regressions} worse in
          B, {diff.improvements} better.
        </p>
      </Section>
      <Section title={`Changed items (${diff.changes.length})`}>
        {diff.changes.length === 0 ? (
          <p className="text-neutral-500">Every shared item came out the same.</p>
        ) : (
          <table className={tableClass}>
            <thead className={headClass}>
              <tr>
                <th>Item</th>
                <th>Change</th>
                <th>A</th>
                <th>B</th>
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {diff.changes.map((c) => (
                <tr key={c.itemId} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td>{data.titles[c.itemId] ?? c.itemId.slice(0, 8)}</td>
                  <td className={KIND_TONE[c.kind]}>{c.kind}</td>
                  <td>
                    {c.a.predictedCategory ?? "error"}{" "}
                    <Badge value={c.a.decision ?? (c.a.errorReason ? "failed" : null)} />
                  </td>
                  <td>
                    {c.b.predictedCategory ?? "error"}{" "}
                    <Badge value={c.b.decision ?? (c.b.errorReason ? "failed" : null)} />
                  </td>
                  <td className="text-xs">{c.notes.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
