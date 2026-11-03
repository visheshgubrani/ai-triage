"use client";

import type { ProductionResponse } from "@ai-triage/contracts";
import { useCallback, useState } from "react";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { usePolling } from "@/lib/use-polling";
import { headClass, ms, pct, RateText, ReplayBadge, Tile, tableClass, usd } from "../ui";

const WINDOWS = [7, 30, 90] as const;

export function ProductionView() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<ProductionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const res = await browserApi.evals.production.$get({ query: { days: String(days) } }, { init: { signal } });
      if (!res.ok) return setError((await readError(res)).error);
      setData((await res.json()) as ProductionResponse);
    },
    [days],
  );
  usePolling(load, 15_000);

  if (error) return <p className="mt-6 text-sm text-red-600">{error}</p>;
  if (!data) return <p className="mt-6 text-sm text-neutral-500">Loading…</p>;
  const audit = data.auditPrecision;
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        Last
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setDays(w)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${w === days ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700"}`}
          >
            {w} days
          </button>
        ))}
        <ReplayBadge replay={data.replay} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Actual spend" hint="Live calls only">
          {usd(data.spend.liveUsd)}
        </Tile>
        <Tile label={data.replay ? "Recorded cost (all calls)" : "Cost (all calls)"}>
          {usd(data.spend.recordedUsd)}
        </Tile>
        <Tile label="Cost / document mean · p95">
          {usd(data.costPerDocument.meanUsd)} · {usd(data.costPerDocument.p95Usd)}
        </Tile>
        <Tile label="Sent to review">
          <RateText rate={data.reviewRate} />
        </Tile>
        <Tile label="Corrected before approval">
          <RateText rate={data.correctionRate} empty="no approvals" />
        </Tile>
        <Tile
          label="Audited auto-approval precision"
          hint="Each audit weighted by 1 / its category's audit rate; the bound uses the effective sample size"
        >
          {audit.n === 0 ? (
            <span className="text-neutral-400">no audits decided (n=0)</span>
          ) : (
            <span className="tabular-nums">
              {pct(audit.rate)}{" "}
              <span className="text-neutral-500">
                n={audit.n} (effective {audit.effectiveN.toFixed(1)}) ≥{pct(audit.lower)}
              </span>
            </span>
          )}
        </Tile>
        <Tile label="Unclassified · failed runs">
          {data.unclassified} · {data.failed}
        </Tile>
      </div>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <Section title="Routing and audits by category">
          <table className={tableClass}>
            <thead className={headClass}>
              <tr>
                <th>Category</th>
                <th>Routed</th>
                <th>Auto</th>
                <th>Audited</th>
                <th>Review rate</th>
              </tr>
            </thead>
            <tbody>
              {data.routing.map((r) => (
                <tr key={r.category}>
                  <td>{r.category}</td>
                  <td>{r.routed}</td>
                  <td>{r.auto}</td>
                  <td>{r.audited}</td>
                  <td>
                    <RateText rate={r.reviewRate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-4 text-xs text-neutral-500">
            Audit verdicts (approved without reclassifying or editing a required field)
          </h3>
          {data.audit.length === 0 ? (
            <p className="text-xs text-neutral-500">No audit tasks decided in this window.</p>
          ) : (
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Category</th>
                  <th>Audit rate</th>
                  <th>Precision</th>
                </tr>
              </thead>
              <tbody>
                {data.audit.map((a) => (
                  <tr key={a.category}>
                    <td>{a.category}</td>
                    <td>{pct(a.auditRate)}</td>
                    <td>
                      <RateText rate={a.precision} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 className="mt-4 text-xs text-neutral-500">Corrections by category</h3>
          <table className={tableClass}>
            <tbody>
              {data.corrections.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td>
                    <RateText rate={c.correctionRate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title={data.replay ? "Latency by stage (recorded live latency)" : "Latency by stage"}>
          <table className={tableClass}>
            <thead className={headClass}>
              <tr>
                <th>Stage</th>
                <th>n</th>
                <th>p50</th>
                <th>p95</th>
              </tr>
            </thead>
            <tbody>
              {data.latencyByStage.map((s) => (
                <tr key={s.stage}>
                  <td>{s.stage}</td>
                  <td>{s.n}</td>
                  <td>{ms(s.p50Ms)}</td>
                  <td>{ms(s.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-4 text-xs text-neutral-500">Cost by day and category</h3>
          <div className="max-h-80 overflow-y-auto">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Day</th>
                  <th>Category</th>
                  <th>Documents</th>
                  <th>Calls</th>
                  <th>{data.replay ? "Recorded" : "Cost"}</th>
                  <th>Live</th>
                </tr>
              </thead>
              <tbody>
                {data.costByDay.map((r) => (
                  <tr key={`${r.day}.${r.category}`}>
                    <td className="whitespace-nowrap tabular-nums">{r.day}</td>
                    <td>{r.category}</td>
                    <td>{r.documents}</td>
                    <td>{r.calls}</td>
                    <td>{usd(r.costUsd)}</td>
                    <td>{usd(r.liveUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </>
  );
}
