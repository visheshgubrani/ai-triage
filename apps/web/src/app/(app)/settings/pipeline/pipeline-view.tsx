"use client";

import type { ModelOption, PipelineChangeRequest, PipelineSettings } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { LoadingBlock } from "@/components/loading";
import { FormMessage } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

type Stage = { model: string; effort: string };

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
    <>
      <NativeSelect
        aria-label={`${label} model`}
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
      </NativeSelect>
      <NativeSelect
        aria-label={`${label} effort`}
        value={stage.effort}
        onChange={(e) => onChange({ ...stage, effort: e.target.value })}
      >
        {(model?.efforts ?? [stage.effort]).map((e) => (
          <option key={e} value={e}>
            effort {e}
          </option>
        ))}
      </NativeSelect>
      {model && !model.available && <p className="w-full text-xs text-warning md:text-right">{model.reason}</p>}
    </>
  );
}

/**
 * The models the pipeline calls, and the sender policy. Saving makes a new version in which every
 * category is reviewed by a person and activates it; auto-approval comes back through evals.
 */
export function PipelineView() {
  const confirm = useConfirm();
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

  if (!settings) return message ? <p className="text-sm text-danger">{message.text}</p> : <LoadingBlock />;
  const automating = settings.config.categories.filter((c) => c.automation === "auto_when_confident");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      automating.length > 0 &&
      !(await confirm({
        title: "Turn off auto-approval?",
        body: `Saving turns off auto-approval for ${automating.map((c) => c.category).join(", ")}: thresholds calibrated for one model don't hold for another. Recalibrate in Evals to turn it back on. Continue?`,
        confirm: "Save and activate",
      }))
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
    <>
      <Section
        title="Active version"
        actions={
          <>
            <Pill tone="accent">v{settings.config.version}</Pill>
            {settings.config.frozenAt && (
              <Pill tone="success" dot>
                Frozen
              </Pill>
            )}
          </>
        }
        description={settings.config.name}
        footer={
          <SectionHint>
            Auto-approval is turned on per category from a calibrated version:{" "}
            <Link href="/evals" className="font-medium text-foreground underline-offset-2 hover:underline">
              Evals
            </Link>{" "}
            → run calib → Freeze → Activate.
          </SectionHint>
        }
      >
        <DataTable className="-mt-1">
          <thead>
            <tr>
              <th>Category</th>
              <th>Routing</th>
              <th className="text-right">Threshold</th>
              <th className="text-right">Audit rate</th>
            </tr>
          </thead>
          <tbody>
            {settings.config.categories.map((c) => (
              <tr key={c.category}>
                <td className="font-mono text-xs">{c.category}</td>
                <td>
                  {c.automation === "auto_when_confident" ? (
                    <Pill tone="success" dot>
                      Auto-approves when confident
                    </Pill>
                  ) : (
                    <Pill dot>Human review</Pill>
                  )}
                </td>
                <td className="text-right tabular-nums">{c.threshold}</td>
                <td className="text-right tabular-nums">{Math.round(c.auditRate * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <Section
        flush
        title="Models"
        description="Saving makes a new version, active at once, in which every category is reviewed by a person."
        footer={
          <>
            {message && <FormMessage message={message} className="mt-0 mr-auto" />}
            <Button type="submit" form="pipeline-form" variant="primary" disabled={busy}>
              Save and activate
            </Button>
          </>
        }
      >
        <form id="pipeline-form" onSubmit={save}>
          <SettingRows>
            <SettingRow label="Classify" hint="Picks the category of each document.">
              <StagePicker label="Classify" stage={classify} models={models} onChange={setClassify} />
            </SettingRow>
            <SettingRow label="Extract" hint="Fills the category's fields, with quotes.">
              <StagePicker label="Extract" stage={extract} models={models} onChange={setExtract} />
            </SettingRow>
            <SettingRow
              label="Require authenticated senders"
              htmlFor="sender-require"
              hint="Forwarded mail that fails DMARC (or DKIM) goes to review. Mail from a connected Gmail mailbox is always checked."
            >
              <Switch id="sender-require" checked={senderRequire} onCheckedChange={setSenderRequire} />
            </SettingRow>
          </SettingRows>
        </form>
      </Section>
    </>
  );
}
