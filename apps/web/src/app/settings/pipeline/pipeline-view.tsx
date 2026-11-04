"use client";

import type { ModelOption, PipelineChangeRequest, PipelineSettings } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

type Stage = { model: string; effort: string };

const select = "rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700";

function StagePicker({
  label,
  stage,
  models,
  onChange,
}: {
  label: string;
  stage: Stage;
  models: ModelOption[];
  onChange: (stage: Stage) => void;
}) {
  const model = models.find((m) => m.ref === stage.model);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 font-medium">{label}</span>
      <select
        aria-label={`${label} model`}
        className={select}
        value={stage.model}
        onChange={(e) => {
          const next = models.find((m) => m.ref === e.target.value);
          onChange({ model: e.target.value, effort: next?.recordedEffort ?? next?.efforts[0] ?? "none" });
        }}
      >
        {models.map((m) => (
          <option key={m.ref} value={m.ref}>
            {m.ref}
            {m.available ? "" : " (not available)"}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} effort`}
        className={select}
        value={stage.effort}
        onChange={(e) => onChange({ ...stage, effort: e.target.value })}
      >
        {(model?.efforts ?? [stage.effort]).map((e) => (
          <option key={e} value={e}>
            effort {e}
          </option>
        ))}
      </select>
      {model && !model.available && <span className="text-xs text-amber-700 dark:text-amber-400">{model.reason}</span>}
    </div>
  );
}

/**
 * The models the pipeline calls, and the sender policy. Saving makes a new version in which every
 * category is reviewed by a person and activates it; auto-approval comes back through evals.
 */
export function PipelineView() {
  const [settings, setSettings] = useState<PipelineSettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [classify, setClassify] = useState<Stage>({ model: "", effort: "" });
  const [extract, setExtract] = useState<Stage>({ model: "", effort: "" });
  const [senderRequire, setSenderRequire] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, m] = await Promise.all([browserApi.pipeline.$get(), browserApi.models.$get()]);
      if (!s.ok) return setMessage({ error: true, text: (await readError(s)).error });
      const body = await s.json();
      setSettings(body);
      setClassify({ model: body.config.classify.model, effort: body.config.classify.effort });
      setExtract({ model: body.config.extract.model, effort: body.config.extract.effort });
      setSenderRequire(body.senderRequire);
      if (m.ok) setModels((await m.json()).models);
    })();
  }, []);

  if (!settings)
    return message ? (
      <p className="text-sm text-red-600">{message.text}</p>
    ) : (
      <p className="text-sm text-neutral-500">Loading…</p>
    );
  const automating = settings.config.categories.filter((c) => c.automation === "auto_when_confident");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      automating.length > 0 &&
      !window.confirm(
        `Saving turns off auto-approval for ${automating.map((c) => c.category).join(", ")}: thresholds calibrated for one model don't hold for another. Recalibrate in Evals to turn it back on. Continue?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await browserApi.pipeline.$put({
        json: { classify, extract, senderRequire } as PipelineChangeRequest,
      });
      if (!res.ok) {
        const err = await readError(res);
        return setMessage({ error: true, text: err.error });
      }
      const body = await res.json();
      setSettings(body);
      setMessage({ error: false, text: `Saved and active as version ${body.config.version}. New documents use it.` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Section title="Active version">
        <p className="text-neutral-600 dark:text-neutral-400">
          v{settings.config.version} {settings.config.name}
          {settings.config.frozenAt ? " · frozen (calibrated)" : ""}
        </p>
        <table className="mt-3 text-sm">
          <thead className="text-xs text-neutral-500">
            <tr>
              <th className="pr-6 text-left font-medium">Category</th>
              <th className="pr-6 text-left font-medium">Routing</th>
              <th className="pr-6 text-left font-medium">Threshold</th>
              <th className="text-left font-medium">Audit rate</th>
            </tr>
          </thead>
          <tbody>
            {settings.config.categories.map((c) => (
              <tr key={c.category}>
                <td className="pr-6">{c.category}</td>
                <td className="pr-6">
                  {c.automation === "auto_when_confident" ? "auto-approve when confident" : "a person reviews"}
                </td>
                <td className="pr-6 tabular-nums">{c.threshold}</td>
                <td className="tabular-nums">{Math.round(c.auditRate * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm">
          Auto-approval is turned on per category from a calibrated version:{" "}
          <Link href="/evals" className="underline underline-offset-2">
            Evals
          </Link>{" "}
          → run calib → Freeze → Activate.
        </p>
      </Section>

      <Section title="Models">
        <form onSubmit={save} className="space-y-3 text-sm">
          <StagePicker label="Classify" stage={classify} models={models} onChange={setClassify} />
          <StagePicker label="Extract" stage={extract} models={models} onChange={setExtract} />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={senderRequire}
              onChange={(e) => setSenderRequire(e.target.checked)}
            />
            <span>
              Require authenticated senders for forwarded mail
              <span className="block text-xs text-neutral-500">
                Mail that fails DMARC (or DKIM) goes to review. Mail synced from a connected Gmail mailbox is always
                checked.
              </span>
            </span>
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            Save and activate
          </Button>
          <p className="text-xs text-neutral-500">
            Saving makes a new version in which every category is reviewed by a person, and makes it active at once.
          </p>
        </form>
        {message && (
          <p
            role={message.error ? "alert" : "status"}
            className={`mt-2 text-sm ${message.error ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
          >
            {message.text}
          </p>
        )}
      </Section>
    </div>
  );
}
