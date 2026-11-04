"use client";

import type { ConfigList, ConfigSummary } from "@ai-triage/contracts";
import { type Effort, MODEL_CATALOG, type ModelRef, modelInfo } from "@ai-triage/core";
import { useCallback, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { Field } from "@/components/field";
import { LoadingBlock } from "@/components/loading";
import { Section } from "@/components/section";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";
import { FrozenBadge, pct } from "../ui";

const MODELS = Object.keys(MODEL_CATALOG) as ModelRef[];
type Stage = { model: ModelRef; effort: Effort };

function StagePicker({ label, value, onChange }: { label: string; value: Stage; onChange: (s: Stage) => void }) {
  const efforts = modelInfo(value.model).efforts;
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      <span className="flex flex-wrap gap-1.5">
        <NativeSelect
          value={value.model}
          onChange={(e) => {
            const model = e.target.value as ModelRef;
            const allowed = modelInfo(model).efforts;
            onChange({ model, effort: allowed.includes(value.effort) ? value.effort : (allowed[0] ?? "none") });
          }}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as Effort })}>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </NativeSelect>
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
      <p className="text-muted-foreground">
        From v{parent.version} {parent.name}. Prompts, schemas and token limits are copied. In replay mode a run needs
        recorded cassettes for its exact model and prompts.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
        </Field>
        <StagePicker label="Classify" value={classify} onChange={setClassify} />
        <StagePicker label="Extract" value={extract} onChange={setExtract} />
      </div>
      <div className="flex flex-wrap gap-3">
        {parent.categories.map((c) => (
          <label key={c.category} className="grid gap-1.5 text-sm font-medium">
            {c.category} threshold
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={thresholds[c.category]}
              onChange={(e) => setThresholds({ ...thresholds, [c.category]: Number(e.target.value) })}
              className="w-24"
            />
          </label>
        ))}
      </div>
      <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
        Create candidate
      </Button>
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

export function ConfigsView({ isAdmin }: { isAdmin: boolean }) {
  const confirm = useConfirm();
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
    if (!(await confirm({ title: `Run new documents with v${c.version} ${c.name}?`, confirm: "Activate" }))) return;
    const res = await browserApi.configs[":id"].activate.$post({ param: { id: c.id } });
    if (!res.ok) return setError((await readError(res)).error);
    await load();
  }

  const parent = list?.configs.find((c) => c.id === parentId);
  return (
    <>
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      <Section title="Versions">
        {!list ? (
          <LoadingBlock />
        ) : (
          <div className="overflow-x-auto">
            <DataTable>
              <thead>
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
                  <tr key={c.id}>
                    <td>
                      v{c.version} {c.name} <FrozenBadge frozen={!!c.frozenAt} />
                      {c.active && (
                        <Pill tone="success" className="ml-1">
                          active
                        </Pill>
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
                    <td className="text-xs text-muted-foreground">{ago(c.createdAt)}</td>
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
            </DataTable>
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
