"use client";

import type { OnboardingResponse } from "@ai-triage/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { browserApi } from "@/lib/api";

/**
 * Getting started (admins): the steps from a fresh workspace to safe automation, checked off from
 * the workspace's own data. Hidden once every step is done, or when dismissed.
 */
export function Checklist() {
  const [state, setState] = useState<OnboardingResponse | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.onboarding.$get();
      if (res.ok) setState(await res.json());
    })();
  }, []);

  if (!state || state.dismissed) return null;
  const done = state.steps.filter((s) => s.done).length;
  if (done === state.steps.length) return null;

  async function dismiss() {
    await browserApi.onboarding.dismiss.$post();
    setState((s) => (s ? { ...s, dismissed: true } : s));
  }

  return (
    <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          Getting started{" "}
          <span className="text-sm font-normal text-neutral-500">
            {done} of {state.steps.length} done
          </span>
        </h2>
        <button type="button" onClick={dismiss} className="text-xs text-neutral-500 underline underline-offset-2">
          Hide
        </button>
      </div>
      <ol className="mt-3 space-y-3">
        {state.steps.map((step) => (
          <li key={step.id} className="flex gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                step.done
                  ? "bg-emerald-600 text-white"
                  : "border border-neutral-300 text-neutral-400 dark:border-neutral-700"
              }`}
            >
              {step.done ? "✓" : ""}
            </span>
            <div>
              <Link
                href={step.href}
                className={`font-medium ${step.done ? "text-neutral-500" : "underline underline-offset-2"}`}
              >
                {step.title}
              </Link>
              {!step.done && <p className="text-sm text-neutral-600 dark:text-neutral-400">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
