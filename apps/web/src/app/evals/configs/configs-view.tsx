"use client";

import type { ConfigList, ConfigSummary } from "@ai-triage/contracts";
import { type Effort, MODEL_CATALOG, type ModelRef, modelInfo } from "@ai-triage/core";
import { useCallback, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { FrozenBadge, headClass, pct, tableClass } from "../ui";

const MODELS = Object.keys(MODEL_CATALOG) as ModelRef[];
type Stage = { model: ModelRef; effort: Effort };

function StagePicker({ label, value, onChange }: { label: string; value: Stage; onChange: (s: Stage) => void }) {
  const efforts = modelInfo(value.model).efforts;
  return (
    <label className="text-xs text-neutral-500">
      {label}
      <span className="mt-1 flex gap-1">
        <select
          value={value.model}
          onChange={(e) => {
            const model = e.target.value as ModelRef;
            const allowed = modelInfo(model).efforts;
            onChange({ model, effort: allowed.includes(value.effort) ? value.effort : (allowed[0] ?? "none") });
          }}
          className="rounded border border-neutral-300 bg-transparent px-1 py-1 text-sm dark:border-neutral-700"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.target.value as Effort })}
          className="rounded border border-neutral-300 bg-transparent px-1 py-1 text-sm dark:border-neutral-700"
        >
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

function CandidateForm({ parent, onCreated }: { parent: ConfigSummary; onCreated: () => void }) {
  const [name, setName] = useState(`${parent.name} candidate`);
  const [classify, setClassify] = useState<Stage>({
    model: parent.classify.model as ModelRef,
    effort: parent.classify.effort as Effort,
  });
  const [extract, setExtract] = useState<Stage>({
    model: parent.extract.model as ModelRef,
    effort: parent.extract.effort as Effort,
  });
  const [thresholds, setThresholds] = useState(
    Object.fromEntries(parent.categories.map((c) => [c.category, c.threshold])),
  );
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setError(null);
    const res = await browserApi.configs.$post({
      json: {
        parentId: parent.id,
        name,
        classify,
        extract,
        categories: parent.categories.map((c) => ({ ...c, threshold: thresholds[c.category] ?? c.threshold })),
      },
    });
    if (!res.ok) return setError((await readError(res)).error);
    onCreated();
  }
  return (
    <div className="space-y-3">
      <p className="text-neutral-600 dark:text-neutral-400">
        From v{parent.version} {parent.name}. Prompts, schemas and token limits are copied. In replay mode a run needs
        recorded cassettes for its exact model and prompts.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-neutral-500">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-64 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
        </label>
        <StagePicker label="Classify" value={classify} onChange={setClassify} />
        <StagePicker label="Extract" value={extract} onChange={setExtract} />
      </div>
      <div className="flex flex-wrap gap-3">
        {parent.categories.map((c) => (
          <label key={c.category} className="text-xs text-neutral-500">
            {c.category} threshold
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={thresholds[c.category]}
              onChange={(e) => setThresholds({ ...thresholds, [c.category]: Number(e.target.value) })}
              className="mt-1 block w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
        ))}
      </div>
      <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
        Create candidate
      </Button>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

export function ConfigsView({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<ConfigList | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await browserApi.configs.$get(undefined, { init: { signal } });
    if (!res.ok) return setError((await readError(res)).error);
    setList(await res.json());
  }, []);
  usePolling(load, 10_000);

  async function activate(c: ConfigSummary) {
    if (!window.confirm(`Run new documents with v${c.version} ${c.name}?`)) return;
    const res = await browserApi.configs[":id"].activate.$post({ param: { id: c.id } });
    if (!res.ok) return setError((await readError(res)).error);
    await load();
  }

  const parent = list?.configs.find((c) => c.id === parentId);
  return (
    <>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <Section title="Versions">
        {!list ? (
          <p className="text-neutral-500">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={headClass}>
                <tr>
                  <th>Version</th>
                  <th>Models</th>
                  <th>Thresholds · automation · audit</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.configs.map((c) => (
                  <tr key={c.id} className="border-t border-neutral-100 align-top dark:border-neutral-900">
                    <td>
                      v{c.version} {c.name} <FrozenBadge frozen={!!c.frozenAt} />
                      {c.active && (
                        <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          active
                        </span>
                      )}
                    </td>
                    <td className="text-xs">
                      classify {c.classify.model} ({c.classify.effort})
                      <br />
                      extract {c.extract.model} ({c.extract.effort})
                    </td>
                    <td className="text-xs">
                      {c.categories.map((k) => (
                        <div key={k.category}>
                          {k.category}: {k.threshold.toFixed(3)} ·{" "}
                          {k.automation === "auto_when_confident" ? "auto" : "review all"} · {pct(k.auditRate)}
                        </div>
                      ))}
                    </td>
                    <td className="text-xs text-neutral-500">{ago(c.createdAt)}</td>
                    <td className="space-x-2 whitespace-nowrap">
                      {isAdmin && (
                        <Button onClick={() => setParentId(c.id)} disabled={parentId === c.id}>
                          Derive
                        </Button>
                      )}
                      {/* Frozen versions, and versions that review every category (nothing to calibrate). */}
                      {isAdmin &&
                        !c.active &&
                        (c.frozenAt || c.categories.every((cat) => cat.automation === "review_all")) && (
                          <Button variant="primary" onClick={() => void activate(c)}>
                            Activate
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
      {isAdmin && parent && (
        <Section title="New candidate">
          <CandidateForm
            key={parent.id}
            parent={parent}
            onCreated={() => {
              setParentId(null);
              void load();
            }}
          />
        </Section>
      )}
    </>
  );
}
