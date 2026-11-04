"use client";

import type { EvalDataset, EvalItem, EvalSplit } from "@ai-triage/contracts";
import { EVAL_SPLITS } from "@ai-triage/core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { LoadingBlock } from "@/components/loading";
import { Section } from "@/components/section";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

export function DatasetsView({ isAdmin }: { isAdmin: boolean }) {
  const confirm = useConfirm();
  const [datasets, setDatasets] = useState<EvalDataset[] | null>(null);
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
    if (
      !(await confirm({
        title: `Retire "${item.sourceTitle ?? item.id}"?`,
        body: "Runs started from now on leave it out.",
        confirm: "Retire item",
        destructive: true,
      }))
    )
      return;
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
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      {datasets?.length === 0 && (
        <Section title="Datasets">
          <p className="text-muted-foreground">
            No eval set yet. The quickest way to start one: approve documents in Review with <em>Add to eval set</em> on
            (it's on by default when you edit a field). The approved values become the labels, in a dataset named Main.
            To import labeled files in bulk, use <code>pnpm eval:import items.jsonl --tenant your-slug</code>.
          </p>
        </Section>
      )}
      {datasets && datasets.length > 0 && (
        <Section title="Datasets">
          <DataTable>
            <thead>
              <tr>
                <th>Name</th>
                {EVAL_SPLITS.map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datasets?.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setDatasetId(d.id)}
                  className={`cursor-pointer ${d.id === datasetId ? "bg-accent font-medium" : ""}`}
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
          </DataTable>
        </Section>
      )}
      {datasets && datasets.length > 0 && (
        <Section
          title="Items"
          actions={
            <NativeSelect aria-label="Split" value={split} onChange={(e) => setSplit(e.target.value as EvalSplit | "")}>
              <option value="">all splits</option>
              {EVAL_SPLITS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          }
        >
          {!items ? (
            <LoadingBlock />
          ) : (
            <div className="overflow-x-auto">
              <DataTable>
                <thead>
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
                    <tr key={i.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => void open(i)}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {i.sourceTitle ?? i.id.slice(0, 8)}
                        </button>
                        {i.tags.length > 0 && (
                          <span className="ml-1 text-xs text-muted-foreground">{i.tags.join(", ")}</span>
                        )}
                      </td>
                      <td>{i.split}</td>
                      <td>{i.expectedCategory}</td>
                      <td className="text-xs text-muted-foreground">
                        {Object.entries(i.expectedFields).filter(([, v]) => v !== null).length}
                      </td>
                      <td className="text-xs">
                        {i.origin}
                        {i.originRef && <span className="text-muted-foreground"> · {i.originRef}</span>}
                      </td>
                      <td className="text-xs text-muted-foreground">{ago(i.createdAt)}</td>
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
              </DataTable>
            </div>
          )}
        </Section>
      )}
    </>
  );
}
