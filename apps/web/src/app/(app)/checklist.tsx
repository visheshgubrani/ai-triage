"use client";

import type { OnboardingResponse } from "@ai-triage/contracts";
import { Circle, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { Progress } from "@/components/ui/progress";
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
    <Section
      className="mt-0"
      title="Getting started"
      description={`${done} of ${state.steps.length} done`}
      actions={
        <Button variant="ghost" size="xs" onClick={dismiss}>
          Hide
        </Button>
      }
    >
      <Progress value={(done / state.steps.length) * 100} aria-label="Setup progress" />
      <ol className="mt-3 space-y-2.5">
        {state.steps.map((step) => (
          <li key={step.id} className="flex gap-2.5">
            {step.done ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
            )}
            <div className="min-w-0">
              <Link
                href={step.href}
                className={`font-medium underline-offset-2 hover:underline ${step.done ? "text-muted-foreground" : ""}`}
              >
                {step.title}
              </Link>
              {!step.done && <p className="text-xs text-muted-foreground">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
