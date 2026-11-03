"use client";

import type { ConfigSummary, EvalRun, EvalRunDetail } from "@ai-triage/contracts";
import { AUTOMATION_MODES, type AutomationMode } from "@ai-triage/core";
import type { ResultDetail } from "@ai-triage/evals";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { humanize } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { FrozenBadge, headClass, ms, pct, RateText, ReplayBadge, Tile, tableClass, usd } from "../../ui";
import { SweepChart } from "./sweep-chart";

const POLL_MS = 3000;
const mark = (ok: boolean) =>
  ok ? <span className="text-emerald-600">✓</span> : <span className="text-red-600">✗</span>;
const show = (v: unknown) =>
  v === null || v === undefined ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v);

type Settings = Record<string, { threshold: number; automation: AutomationMode; auditRate: number }>;

function FreezeForm({ run, config, sweeps }: { run: EvalRun; config: ConfigSummary; sweeps: EvalRunDetail["sweeps"] }) {
  const router = useRouter();
  const [name, setName] = useState(`${config.name} (calibrated)`);
  const [settings, setSettings] = useState<Settings>(
    Object.fromEntries(
      config.categories.map((c) => [
        c.category,
        { threshold: c.threshold, automation: c.automation, auditRate: c.auditRate },
      ]),
    ),
  );
  const [frozen, setFrozen] = useState<ConfigSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (category: string, patch: Partial<Settings[string]>) =>
    setSettings((s) => ({ ...s, [category]: { ...(s[category] as Settings[string]), ...patch } }));

  async function freeze() {
    setBusy(true);
    setError(null);
    try {
      const categories = Object.entries(settings).map(([category, v]) => ({ category, ...v }));
      const res = await browserApi.evals.runs[":id"].freeze.$post({
        param: { id: run.id },
        json: { name, categories },
      });
      if (!res.ok) return setError((await readError(res)).error);
      setFrozen(((await res.json()) as { config: ConfigSummary }).config);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (!frozen) return;
    setBusy(true);
    try {
      const res = await browserApi.evals.runs.$post({
        json: { datasetId: run.datasetId, split: "test", configId: frozen.id },
      });
      if (!res.ok) return setError((await readError(res)).error);
      router.push(`/evals/runs/${((await res.json()) as { runId: string }).runId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Freeze">
      <p className="mb-3 text-neutral-600 dark:text-neutral-400">
        Choose each category's threshold from its sweep (click a row), then freeze: a new, immutable version of this
        config with these settings. Only frozen versions run on test or can be activated.
      </p>
      <table className={tableClass}>
        <thead className={headClass}>
          <tr>
            <th>Category</th>
            <th>Threshold</th>
            <th>Automation</th>
            <th>Audit rate</th>
            <th>At this threshold (calib)</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(settings).map(([category, v]) => {
            const sweep = sweeps.find((s) => s.category === category);
            const point = sweep?.points.filter((p) => p.threshold >= v.threshold)[0];
            return (
              <tr key={category}>
                <td>{category}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.001}
                    value={v.threshold}
                    onChange={(e) => set(category, { threshold: Number(e.target.value) })}
                    className="w-24 rounded border border-neutral-300 bg-transparent px-1 dark:border-neutral-700"
                  />
                </td>
                <td>
                  <select
                    value={v.automation}
                    onChange={(e) => set(category, { automation: e.target.value as AutomationMode })}
                    className="rounded border border-neutral-300 bg-transparent px-1 dark:border-neutral-700"
                  >
                    {AUTOMATION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={v.auditRate}
                    onChange={(e) => set(category, { auditRate: Number(e.target.value) })}
                    className="w-20 rounded border border-neutral-300 bg-transparent px-1 dark:border-neutral-700"
                  />
                </td>
                <td className="text-xs">
                  {point ? (
                    <>
                      auto <RateText rate={point.autoRate} />, precision <RateText rate={point.precision} />
                    </>
                  ) : (
                    <span className="text-neutral-500">no auto-approvals</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Name of the frozen version"
          className="w-72 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
        <Button variant="primary" onClick={() => void freeze()} disabled={busy || !!frozen || !name.trim()}>
          Freeze
        </Button>
        {frozen && (
          <>
            <span className="text-emerald-700 dark:text-emerald-400">
              Frozen as v{frozen.version} {frozen.name}.
            </span>
            <Button onClick={() => void runTest()} disabled={busy}>
              Run it on test
            </Button>
          </>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
      <SweepPicker sweeps={sweeps} onPick={(category, threshold) => set(category, { threshold })} chosen={settings} />
    </Section>
  );
}

function SweepPicker({
  sweeps,
  onPick,
  chosen,
}: {
  sweeps: EvalRunDetail["sweeps"];
  onPick?: (category: string, threshold: number) => void;
  chosen: Settings | null;
}) {
  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-2">
      {sweeps.map((sweep) => (
        <div key={sweep.category}>
          <h3 className="font-medium">
            {sweep.category}{" "}
            <span className="text-xs font-normal text-neutral-500">
              {sweep.n} predicted, {sweep.eligible} that only the threshold or automation held back
            </span>
          </h3>
          <SweepChart sweep={sweep} chosen={chosen?.[sweep.category]?.threshold ?? sweep.current} />
          <table className={`${tableClass} mt-2`}>
            <thead className={headClass}>
              <tr>
                <th>Threshold</th>
                <th>Auto-approved</th>
                <th>Precision</th>
              </tr>
            </thead>
            <tbody>
              {sweep.points.map((p) => (
                <tr
                  key={p.threshold}
                  onClick={() => onPick?.(sweep.category, p.threshold)}
                  className={`${onPick ? "cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900" : ""} ${
                    chosen?.[sweep.category]?.threshold === p.threshold ? "font-medium" : ""
                  }`}
                >
                  <td className="tabular-nums">
                    {p.threshold.toFixed(3)}
                    {p.threshold === sweep.current ? (
                      <span className="text-xs text-neutral-500"> (current)</span>
                    ) : null}
                  </td>
                  <td>
                    <RateText rate={p.autoRate} />
                  </td>
                  <td>
                    <RateText rate={p.precision} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Items({ results }: { results: ResultDetail[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead className={headClass}>
          <tr>
            <th>Item</th>
            <th>Expected</th>
            <th>Predicted</th>
            <th title="category · required fields · all fields">Correct</th>
            <th>Score</th>
            <th>Decision</th>
            <th>Why</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <Fragment key={r.itemId}>
              <tr
                onClick={() => setOpen(open === r.itemId ? null : r.itemId)}
                className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900"
              >
                <td>
                  {r.sourceTitle ?? r.itemId.slice(0, 8)}
                  {r.tags.length > 0 && <span className="ml-1 text-xs text-neutral-500">{r.tags.join(", ")}</span>}
                </td>
                <td>{r.expectedCategory}</td>
                <td>{r.predictedCategory ?? "-"}</td>
                <td className="whitespace-nowrap">
                  {mark(r.categoryCorrect)} {mark(r.requiredCorrect)} {mark(r.fullyCorrect)}
                </td>
                <td className="tabular-nums">{r.score?.toFixed(3) ?? "-"}</td>
                <td>
                  <Badge value={r.decision ?? (r.errorReason ? "failed" : null)} />
                </td>
                <td className="max-w-xs text-xs text-neutral-600 dark:text-neutral-400">
                  {r.errorReason ? `${r.errorReason}: ${r.error ?? ""}` : r.reasons.join(", ")}
                </td>
                <td className="tabular-nums">{usd(r.costUsd)}</td>
              </tr>
              {open === r.itemId && (
                <tr>
                  <td colSpan={8} className="bg-neutral-50 dark:bg-neutral-900">
                    {r.fieldScores && Object.keys(r.fieldScores).length > 0 ? (
                      <table className={tableClass}>
                        <thead className={headClass}>
                          <tr>
                            <th>Field</th>
                            <th>Label</th>
                            <th>Predicted</th>
                            <th>Comparator</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(r.fieldScores).map(([field, s]) => (
                            <tr key={field}>
                              <td>
                                {humanize(field)}
                                {s.required && <span className="text-xs text-neutral-500"> required</span>}
                              </td>
                              <td className="max-w-xs truncate">{show(r.expectedFields[field])}</td>
                              <td className="max-w-xs truncate">{show(r.predictedFields?.[field])}</td>
                              <td className="text-xs text-neutral-500">{s.comparator}</td>
                              <td>
                                {mark(s.correct)}
                                {s.comparator === "set_f1" && s.score < 1 ? ` ${pct(s.score)}` : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="py-1 text-xs text-neutral-500">
                        {r.categoryCorrect ? "No fields to grade." : "Wrong category: fields aren't graded."}
                      </p>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunView({ runId, isAdmin }: { runId: string; isAdmin: boolean }) {
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [peers, setPeers] = useState<EvalRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (detail && detail.run.status !== "queued" && detail.run.status !== "running") return;
      const res = await browserApi.evals.runs[":id"].$get({ param: { id: runId } }, { init: { signal } });
      if (!res.ok) return setError((await readError(res)).error);
      const body = (await res.json()) as EvalRunDetail;
      setDetail(body);
      const list = await browserApi.evals.runs.$get({ query: { datasetId: body.run.datasetId } }, { init: { signal } });
      if (list.ok) setPeers((await list.json()).runs.filter((r) => r.split === body.run.split && r.id !== runId));
    },
    [runId, detail],
  );
  usePolling(load, POLL_MS);

  if (error) return <p className="mt-6 text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="mt-6 text-sm text-neutral-500">Loading…</p>;
  const { run, config, metrics } = detail;
  const replay = run.llmMode === "replay";
  return (
    <>
      <h1 className="mt-2 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
        {run.split} run · v{config.version} {config.name} <FrozenBadge frozen={!!config.frozenAt} />
        <ReplayBadge replay={replay} />
      </h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {run.datasetName} · {config.classify.model} ({config.classify.effort}) classifies, {config.extract.model} (
        {config.extract.effort}) extracts · <Badge value={run.status} /> {run.done}/{run.itemCount} items
        {run.error && <span className="text-red-600"> · {run.error}</span>}
      </p>
      {peers.length > 0 && (
        <p className="mt-2 text-sm">
          Compare with:{" "}
          {peers.slice(0, 6).map((p) => (
            <Link key={p.id} href={`/evals/diff?a=${p.id}&b=${run.id}`} className="mr-3 underline underline-offset-2">
              v{p.config.version} {p.config.name}
            </Link>
          ))}
        </p>
      )}

      {!metrics ? (
        <p className="mt-6 text-sm text-neutral-500">The run is still going; results appear when every item is done.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Category accuracy">
              <RateText rate={metrics.classification.accuracy} />
            </Tile>
            <Tile
              label="Auto-approval precision"
              hint="Right category and every required field correct, among auto-approvals"
            >
              <RateText rate={metrics.routing.autoPrecision} empty="no auto-approvals" />
            </Tile>
            <Tile label="Required fields right">
              <RateText rate={metrics.extraction.requiredCorrect} />
            </Tile>
            <Tile label="Sent to review">
              <RateText rate={metrics.routing.reviewRate} />
            </Tile>
            <Tile
              label={replay ? "Recorded cost (run)" : "Cost (run)"}
              hint="Every attempt: equals the sum of the run's llm_calls"
            >
              {usd(metrics.cost.totalUsd)}
              {replay && (
                <span className="ml-1 text-xs font-normal text-neutral-500">
                  actual spend {usd(metrics.cost.liveUsd)}
                </span>
              )}
            </Tile>
            <Tile label="Cost / item mean · p50 · p95">
              {usd(metrics.cost.perItemUsd.mean)} · {usd(metrics.cost.perItemUsd.p50)} ·{" "}
              {usd(metrics.cost.perItemUsd.p95)}
            </Tile>
            <Tile label={replay ? "Recorded live latency p50 · p95" : "Latency p50 · p95"}>
              {ms(metrics.cost.latencyMs.p50)} · {ms(metrics.cost.latencyMs.p95)}
            </Tile>
            <Tile label="Errors">{metrics.summary.errors}</Tile>
          </div>

          <div className="grid gap-x-6 lg:grid-cols-2">
            <Section title="Classification">
              <table className={tableClass}>
                <thead className={headClass}>
                  <tr>
                    <th>Category</th>
                    <th>Labeled</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>F1</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.classification.perCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td>{c.support}</td>
                      <td>{pct(c.precision)}</td>
                      <td>{pct(c.recall)}</td>
                      <td>{pct(c.f1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mt-4 text-xs text-neutral-500">Confusion (rows: label, columns: predicted)</h3>
              <table className={tableClass}>
                <thead className={headClass}>
                  <tr>
                    <th />
                    {metrics.classification.confusion.predicted.map((p) => (
                      <th key={p}>{p}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.classification.confusion.expected.map((e, i) => (
                    <tr key={e}>
                      <td className="text-neutral-500">{e}</td>
                      {metrics.classification.confusion.counts[i]?.map((n, j) => (
                        <td
                          key={metrics.classification.confusion.predicted[j]}
                          className={`tabular-nums ${n === 0 ? "text-neutral-300 dark:text-neutral-700" : e === metrics.classification.confusion.predicted[j] ? "font-medium" : "text-red-600"}`}
                        >
                          {n}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Routing by predicted category">
              <table className={tableClass}>
                <thead className={headClass}>
                  <tr>
                    <th>Category</th>
                    <th>n</th>
                    <th>Auto-approved</th>
                    <th>Auto precision</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.routing.perCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td>{c.n}</td>
                      <td>
                        <RateText rate={c.autoRate} />
                      </td>
                      <td>
                        <RateText rate={c.autoPrecision} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mt-4 text-xs text-neutral-500">Why items went to review</h3>
              <p className="text-xs">{metrics.routing.reasons.map((r) => `${r.reason} ${r.n}`).join(" · ") || "-"}</p>
              <h3 className="mt-4 text-xs text-neutral-500">Cost and latency by stage{replay ? " (recorded)" : ""}</h3>
              <table className={tableClass}>
                <thead className={headClass}>
                  <tr>
                    <th>Stage</th>
                    <th>Calls</th>
                    <th>Cost</th>
                    <th>p50 · p95</th>
                    <th>Cache hits</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.cost.byStage.map((s) => (
                    <tr key={s.stage}>
                      <td>{s.stage}</td>
                      <td>{s.calls}</td>
                      <td>{usd(s.costUsd)}</td>
                      <td>
                        {ms(s.latencyMs.p50)} · {ms(s.latencyMs.p95)}
                      </td>
                      <td>{pct(s.cacheHitRatio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>

          <Section title="Extraction: per-field accuracy (items with the right category)">
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={headClass}>
                  <tr>
                    <th>Category</th>
                    <th>Field</th>
                    <th>Comparator</th>
                    <th>Labels stating it</th>
                    <th>Correct</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.extraction.perField.map((f) => (
                    <tr key={`${f.category}.${f.field}`}>
                      <td className="text-neutral-500">{f.category}</td>
                      <td>
                        {humanize(f.field)}
                        {f.required && <span className="text-xs text-neutral-500"> required</span>}
                      </td>
                      <td className="text-xs text-neutral-500">{f.comparator}</td>
                      <td>{f.stated}</td>
                      <td>
                        <RateText rate={f.correct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Every field right, over all items: <RateText rate={metrics.extraction.fullyCorrect} />. Free-text fields
              are graded by presence only.
            </p>
          </Section>

          {run.split === "calib" && run.status === "done" ? (
            isAdmin ? (
              <FreezeForm run={run} config={config} sweeps={detail.sweeps} />
            ) : (
              <Section title="Threshold sweep">
                <SweepPicker sweeps={detail.sweeps} chosen={null} />
              </Section>
            )
          ) : null}

          <Section title="Reliability: does the score mean what it says?">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Score</th>
                  <th>n</th>
                  <th>Category right</th>
                  <th>Right end to end</th>
                </tr>
              </thead>
              <tbody>
                {detail.reliability.map((b) => (
                  <tr key={b.from}>
                    <td className="tabular-nums">
                      {b.from.toFixed(2)}–{b.to.toFixed(2)}
                    </td>
                    <td>{b.n}</td>
                    <td>
                      <RateText rate={b.categoryAccuracy} />
                    </td>
                    <td>
                      <RateText rate={b.correct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}

      <Section title={`Items (${detail.results.length})`}>
        <Items results={detail.results} />
      </Section>
    </>
  );
}
