"use client";

import type { BudgetSettings } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { FormMessage, type Message } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The daily cap on live model spend, and today's use of it. Replayed calls don't count. */
export function BudgetSettingsView() {
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [cap, setCap] = useState("");
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    // The budget banner links here; the page renders after the browser looked for the anchor.
    if (window.location.hash === "#budget") document.getElementById("budget")?.scrollIntoView();
    void (async () => {
      const res = await browserApi.settings.budget.$get();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      const b = await res.json();
      setBudget(b);
      setCap(String(b.capUsd));
    })();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const capUsd = Number(cap);
    if (!Number.isFinite(capUsd) || capUsd < 0) return setMessage({ error: true, text: "Enter an amount in USD." });
    const res = await browserApi.settings.budget.$put({ json: { capUsd } });
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setBudget(await res.json());
    setMessage({ error: false, text: "Saved. It applies to today's budget at once." });
  }

  const used = budget ? budget.spentUsd + budget.reservedUsd : 0;
  return (
    <Section
      flush
      id="budget"
      className="scroll-mt-20"
      title="Daily LLM budget"
      description="Live model calls stop for the day at the cap; runs then wait for a reviewer."
      footer={
        <>
          {message ? (
            <FormMessage message={message} className="mt-0 mr-auto" />
          ) : (
            <SectionHint>Replayed calls are free and don't count.</SectionHint>
          )}
          <Button type="submit" form="budget-form" variant="primary">
            Save
          </Button>
        </>
      }
    >
      <SettingRows>
        <SettingRow label="Today" hint={budget ? `${budget.day}, UTC` : undefined}>
          {budget ? (
            <div className="w-full md:max-w-xs">
              <Progress
                value={budget.capUsd > 0 ? Math.min(100, (used / budget.capUsd) * 100) : 100}
                aria-label="Today's spend against the cap"
                className="h-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">{money(budget.spentUsd)}</span> spent ·{" "}
                {money(budget.reservedUsd)} reserved · {money(budget.capUsd)} cap
              </p>
            </div>
          ) : (
            <Skeleton className="h-6 w-full md:max-w-xs" />
          )}
        </SettingRow>
        <SettingRow label="Daily cap" htmlFor="budget-cap" hint="In USD, for live calls across every stage.">
          <form id="budget-form" onSubmit={save}>
            <InputGroup className="w-40">
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="budget-cap"
                type="number"
                min="0"
                step="0.01"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className="tabular-nums"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>/ day</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </SettingRow>
      </SettingRows>
    </Section>
  );
}
