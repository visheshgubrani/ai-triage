"use client";

import type { EvalDiffResponse, EvalRun } from "@ai-triage/contracts";
import type { Rate } from "@ai-triage/evals";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/badge";
import { DataTable } from "@/components/data-table";
import { LoadingBlock } from "@/components/loading";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { FrozenBadge, ms, RateText, ReplayBadge, usd } from "../ui";

const KIND_TONE = { regression: "text-danger", improvement: "text-success", changed: "text-muted-foreground" } as const;

function RunHeader({ label, run }: { label: string; run: EvalRun }) {
  return (
    <Link
      href={`/evals/runs/${run.id}`}
      className="block rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/8 transition-colors hover:bg-muted/60"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">
        v{run.config.version} {run.config.name} <FrozenBadge frozen={run.config.frozen} />{" "}
        <ReplayBadge replay={run.llmMode === "replay"} models={[run.config.classifyModel, run.config.extractModel]} />
      </div>
      <div className="text-xs text-muted-foreground">
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
  if (error) {
    return (
      <>
        <PageHeader back={{ href: "/evals", label: "Evals" }} title="Run A vs run B" />
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      </>
    );
  }
  if (!data) return <LoadingBlock />;
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
      <PageHeader back={{ href: "/evals", label: "Evals" }} title="Run A vs run B" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <RunHeader label="A" run={data.a} />
        <RunHeader label="B" run={data.b} />
      </div>
      <Section title="Summary">
        <DataTable>
          <thead>
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
        </DataTable>
        <p className="mt-2 text-xs text-muted-foreground">
          {diff.shared} items in both runs ({diff.onlyA} only in A, {diff.onlyB} only in B): {diff.regressions} worse in
          B, {diff.improvements} better.
        </p>
      </Section>
      <Section title={`Changed items (${diff.changes.length})`}>
        {diff.changes.length === 0 ? (
          <p className="text-muted-foreground">Every shared item came out the same.</p>
        ) : (
          <DataTable>
            <thead>
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
                <tr key={c.itemId}>
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
          </DataTable>
        )}
      </Section>
    </>
  );
}
