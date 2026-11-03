"use client";

import type { BudgetSettings } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The daily cap on live model spend, and today's use of it. Replayed calls don't count. */
export function BudgetSettingsView() {
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [cap, setCap] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
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

  return (
    <Section title="Daily LLM budget">
      <p className="text-neutral-600 dark:text-neutral-400">
        Live model calls stop for the day once the cap is reached; runs then fail as budget exhausted and wait for a
        reviewer.
        {budget && (
          <>
            {" "}
            Today ({budget.day}, UTC): {money(budget.spentUsd)} spent, {money(budget.reservedUsd)} reserved.
          </>
        )}
      </p>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="budget-cap">Cap (USD per day)</label>
        <input
          id="budget-cap"
          type="number"
          min="0"
          step="0.01"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className="w-32 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
        />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </form>
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-2 ${message.error ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
        >
          {message.text}
        </p>
      )}
    </Section>
  );
}
