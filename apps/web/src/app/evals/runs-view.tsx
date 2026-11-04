"use client";

import type { ConfigList, EvalDatasetList, EvalRun, EvalRunList, EvalSplit } from "@ai-triage/contracts";
import { EVAL_SPLITS } from "@ai-triage/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { FrozenBadge, headClass, ms, RateText, ReplayBadge, Tile, tableClass, usd } from "./ui";

const POLL_MS = 5000;

function Headline({ run, active }: { run: EvalRun | undefined; active: boolean }) {
  if (!run?.summary) {
    return (
      <p className="text-neutral-500">No finished test run yet. Freeze a config from a calib run and run it on test.</p>
    );
  }
  const s = run.summary;
  return (
    <>
      <p className="mb-3 flex flex-wrap items-center gap-2 text-neutral-600 dark:text-neutral-400">
        <Link href={`/evals/runs/${run.id}`} className="underline underline-offset-2">
          Test run of v{run.config.version} {run.config.name}
        </Link>
        {!active && <span className="text-xs">(not the active config: activate it to run new documents with it)</span>}
        <FrozenBadge frozen={run.config.frozen} /> <ReplayBadge replay={s.replay} /> · {run.datasetName} ·{" "}
        {run.finishedAt ? ago(run.finishedAt) : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Category accuracy">
          <RateText rate={s.accuracy} />
        </Tile>
        <Tile
          label="Auto-approval precision"
          hint="Right category and every required field correct, among auto-approvals"
        >
          <RateText rate={s.autoPrecision} empty="no auto-approvals" />
        </Tile>
        <Tile label="Auto-approved">
          <RateText rate={s.autoRate} />
        </Tile>
        <Tile label={s.replay ? "Recorded cost / item · latency p50" : "Cost / item · latency p50"}>
          {usd(s.perItemUsd)} · {ms(s.latencyP50Ms)}
        </Tile>
      </div>
    </>
  );
}

export function RunsView({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [runs, setRuns] = useState<EvalRunList | null>(null);
  const [datasets, setDatasets] = useState<EvalDatasetList["datasets"]>([]);
  const [configs, setConfigs] = useState<ConfigList["configs"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ datasetId: string; split: EvalSplit; configId: string }>({
    datasetId: "",
    split: "dev",
    configId: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const init = { init: { signal } };
    const [r, d, c] = await Promise.all([
      browserApi.evals.runs.$get({ query: {} }, init),
      browserApi.evals.datasets.$get(undefined, init),
      browserApi.configs.$get(undefined, init),
    ]);
    if (!r.ok) return setError((await readError(r)).error);
    setError(null);
    setRuns(await r.json());
    if (d.ok) setDatasets((await d.json()).datasets);
    if (c.ok) setConfigs((await c.json()).configs);
  }, []);
  usePolling(load, POLL_MS);

  const datasetId = form.datasetId || datasets[0]?.id || "";
  const configId = form.configId || configs.find((c) => c.active)?.id || "";
  const config = configs.find((c) => c.id === configId);
  const dataset = datasets.find((d) => d.id === datasetId);
  const active = configs.find((c) => c.active);
  // The active config's latest test run; else the latest test run of any (necessarily frozen) config.
  const tests = runs?.runs.filter((r) => r.split === "test" && r.status === "done") ?? [];
  const headline = tests.find((r) => r.config.id === active?.id) ?? tests[0];

  async function start() {
    if (!dataset || !config) return;
    const n = dataset.counts[form.split];
    if (
      runs?.newRunMode === "live" &&
      !window.confirm(
        `This deployment calls models live: ${n} items, up to ${n * 2} paid calls, drawn from today's budget. Start?`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await browserApi.evals.runs.$post({ json: { datasetId, split: form.split, configId } });
      if (!res.ok) return setError((await readError(res)).error);
      const body = (await res.json()) as { runId: string };
      router.push(`/evals/runs/${body.runId}`);
    } finally {
      setBusy(false);
    }
  }

  const testBlocked = form.split === "test" && config && !config.frozenAt;
  return (
    <>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <Section title="Headline: test-split results">
        <Headline run={headline} active={headline?.config.id === active?.id} />
      </Section>

      {isAdmin && (
        <Section title="New run">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-neutral-500">
              Dataset
              <select
                className="mt-1 block rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                value={datasetId}
                onChange={(e) => setForm({ ...form, datasetId: e.target.value })}
              >
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              Split
              <select
                className="mt-1 block rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                value={form.split}
                onChange={(e) => setForm({ ...form, split: e.target.value as EvalSplit })}
              >
                {EVAL_SPLITS.map((s) => (
                  <option key={s} value={s}>
                    {s} ({dataset?.counts[s] ?? 0})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              Config
              <select
                className="mt-1 block max-w-xs rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                value={configId}
                onChange={(e) => setForm({ ...form, configId: e.target.value })}
              >
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    v{c.version} {c.name}
                    {c.frozenAt ? " (frozen)" : ""}
                    {c.active ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={busy || !config || !dataset || !!testBlocked}
            >
              Run{runs?.newRunMode === "live" ? " (live)" : ""}
            </Button>
          </div>
          {testBlocked && (
            <p className="mt-2 text-xs text-neutral-500">
              Test runs need a frozen config: run calib, choose thresholds from its sweep, then Freeze.
            </p>
          )}
        </Section>
      )}

      <Section title="Runs">
        {!runs ? (
          <p className="text-neutral-500">Loading…</p>
        ) : runs.runs.length === 0 ? (
          <p className="text-neutral-500">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Started</th>
                  <th>Split</th>
                  <th>Config</th>
                  <th>Status</th>
                  <th>Accuracy</th>
                  <th>Auto precision</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.runs.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-900">
                    <td>
                      <Link href={`/evals/runs/${r.id}`} className="underline underline-offset-2">
                        {ago(r.createdAt)}
                      </Link>
                    </td>
                    <td>
                      {r.split} <span className="text-neutral-500">· {r.datasetName}</span>
                    </td>
                    <td>
                      v{r.config.version} {r.config.name} <FrozenBadge frozen={r.config.frozen} />
                      <div className="text-xs text-neutral-500">{r.config.classifyModel}</div>
                    </td>
                    <td>
                      <Badge value={r.status} />{" "}
                      {r.status !== "done" && (
                        <span className="text-xs text-neutral-500">
                          {r.done}/{r.itemCount}
                        </span>
                      )}
                      {r.error && <div className="text-xs text-red-600">{r.error}</div>}
                    </td>
                    <td>{r.summary ? <RateText rate={r.summary.accuracy} /> : "-"}</td>
                    <td>{r.summary ? <RateText rate={r.summary.autoPrecision} /> : "-"}</td>
                    <td className="tabular-nums">
                      {r.summary ? usd(r.summary.totalUsd) : "-"}{" "}
                      <ReplayBadge
                        replay={r.llmMode === "replay"}
                        models={[r.config.classifyModel, r.config.extractModel]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
