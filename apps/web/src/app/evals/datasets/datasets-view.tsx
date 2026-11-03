"use client";

import type { EvalDataset, EvalItem, EvalSplit } from "@ai-triage/contracts";
import { EVAL_SPLITS } from "@ai-triage/core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { headClass, tableClass } from "../ui";

export function DatasetsView({ isAdmin }: { isAdmin: boolean }) {
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [split, setSplit] = useState<EvalSplit | "">("");
  const [items, setItems] = useState<EvalItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.evals.datasets.$get();
      if (!res.ok) return setError((await readError(res)).error);
      const body = await res.json();
      setDatasets(body.datasets);
      setDatasetId((id) => id ?? body.datasets[0]?.id ?? null);
    })();
  }, []);

  const loadItems = useCallback(async () => {
    if (!datasetId) return;
    const res = await browserApi.evals.datasets[":id"].items.$get({
      param: { id: datasetId },
      query: split ? { split } : {},
    });
    if (!res.ok) return setError((await readError(res)).error);
    setItems((await res.json()).items);
  }, [datasetId, split]);
  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function retire(item: EvalItem) {
    if (!window.confirm(`Retire "${item.sourceTitle ?? item.id}"? Runs started from now on leave it out.`)) return;
    const res = await browserApi.evals.items[":id"].retire.$post({ param: { id: item.id } });
    if (!res.ok) return setError((await readError(res)).error);
    await loadItems();
  }

  async function open(item: EvalItem) {
    const res = await browserApi.evals.items[":id"].source.$get({ param: { id: item.id } });
    if (res.ok) window.open((await res.json()).url, "_blank", "noopener");
  }

  return (
    <>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <Section title="Datasets">
        <table className={tableClass}>
          <thead className={headClass}>
            <tr>
              <th>Name</th>
              {EVAL_SPLITS.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr
                key={d.id}
                onClick={() => setDatasetId(d.id)}
                className={`cursor-pointer ${d.id === datasetId ? "font-medium" : ""}`}
              >
                <td>{d.name}</td>
                {EVAL_SPLITS.map((s) => (
                  <td key={s} className="tabular-nums">
                    {d.counts[s]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section
        title="Items"
        actions={
          <select
            aria-label="Split"
            value={split}
            onChange={(e) => setSplit(e.target.value as EvalSplit | "")}
            className="rounded border border-neutral-300 bg-transparent px-1 text-sm dark:border-neutral-700"
          >
            <option value="">all splits</option>
            {EVAL_SPLITS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        }
      >
        {!items ? (
          <p className="text-neutral-500">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Source</th>
                  <th>Split</th>
                  <th>Label</th>
                  <th>Fields stated</th>
                  <th>Origin</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-t border-neutral-100 dark:border-neutral-900">
                    <td>
                      <button type="button" onClick={() => void open(i)} className="underline underline-offset-2">
                        {i.sourceTitle ?? i.id.slice(0, 8)}
                      </button>
                      {i.tags.length > 0 && <span className="ml-1 text-xs text-neutral-500">{i.tags.join(", ")}</span>}
                    </td>
                    <td>{i.split}</td>
                    <td>{i.expectedCategory}</td>
                    <td className="text-xs text-neutral-500">
                      {Object.entries(i.expectedFields).filter(([, v]) => v !== null).length}
                    </td>
                    <td className="text-xs">
                      {i.origin}
                      {i.originRef && <span className="text-neutral-500"> · {i.originRef}</span>}
                    </td>
                    <td className="text-xs text-neutral-500">{ago(i.createdAt)}</td>
                    <td>
                      {isAdmin && (
                        <Button variant="danger" onClick={() => void retire(i)}>
                          Retire
                        </Button>
                      )}
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
