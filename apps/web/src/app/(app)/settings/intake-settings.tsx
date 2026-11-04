"use client";

import type { IntakeSettings } from "@ai-triage/contracts";
import { useEffect, useState } from "react";
import { ToggleRow } from "@/components/field";
import { FormMessage } from "@/components/notice";
import { Section } from "@/components/section";
import { Switch } from "@/components/ui/switch";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const FILTERS: { key: keyof IntakeSettings; label: string; detail: string }[] = [
  {
    key: "auto_replies",
    label: "Auto-replies",
    detail: "Out-of-office and other automatic answers (Auto-Submitted, X-Autoreply, Precedence: auto_reply).",
  },
  {
    key: "bounces",
    label: "Bounces and read receipts",
    detail: "Delivery failure notices and read receipts (multipart/report).",
  },
  {
    key: "bulk",
    label: "Bulk and list mail",
    detail:
      "Newsletters and mailing lists (List-Id, List-Unsubscribe, Precedence: bulk). Off by default: some vendors send invoices from bulk mailers.",
  },
];

/** Which kinds of automatic mail end as `skipped` before any model call (headers only, never content). */
export function IntakeSettingsView() {
  const [filters, setFilters] = useState<IntakeSettings | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.settings.intake.$get();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      setFilters(await res.json());
    })();
  }, []);

  async function toggle(key: keyof IntakeSettings) {
    if (!filters) return;
    const next = { ...filters, [key]: !filters[key] };
    const res = await browserApi.settings.intake.$put({ json: next });
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setFilters(next);
    setMessage({ error: false, text: "Saved. It applies to mail that arrives from now on." });
  }

  return (
    <Section title="Intake filters">
      <p className="text-muted-foreground">
        Mail that is noise by its headers ends as <em>skipped</em>: no model call, no review task. Find it under
        Documents → Skipped, where Process anyway runs one through the pipeline.
      </p>
      {filters && (
        <ul className="mt-3 space-y-3">
          {FILTERS.map((f) => (
            <li key={f.key}>
              <ToggleRow
                label={f.label}
                detail={f.detail}
                control={<Switch checked={filters[f.key]} onCheckedChange={() => toggle(f.key)} />}
              />
            </li>
          ))}
        </ul>
      )}
      <FormMessage message={message} />
    </Section>
  );
}
