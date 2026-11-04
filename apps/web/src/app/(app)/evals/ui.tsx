import type { Rate } from "@ai-triage/evals";
import Link from "next/link";
import type { ReactNode } from "react";
import { Pill } from "@/components/badge";
import { Page, PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";

// Small pieces every evals page uses. Every rate is shown with its n and 95% Wilson lower bound, and
// replayed figures say so (docs/architecture.md §8).

export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined ? "-" : `${(x * 100).toFixed(digits)}%`;

export const usd = (x: number | null | undefined) =>
  x === null || x === undefined ? "-" : x !== 0 && Math.abs(x) < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(2)}`;

export const ms = (x: number | null | undefined) =>
  x === null || x === undefined ? "-" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;

/** "83% 5/6 ≥44%": the rate, k of n, and its lower bound. */
export function RateText({ rate, empty = "-" }: { rate: Rate; empty?: string }) {
  if (rate.n === 0) return <span className="text-muted-foreground">{empty} (n=0)</span>;
  return (
    <span title={`${rate.k} of ${rate.n}; 95% Wilson lower bound ${pct(rate.lower, 1)}`} className="tabular-nums">
      {pct(rate.rate)}{" "}
      <span className="text-[0.85em] font-normal text-muted-foreground">
        {rate.k}/{rate.n} ≥{pct(rate.lower)}
      </span>
    </span>
  );
}

/** "Simulated" for a run on `sim:` models (no real model answered), else "Replay" for cassettes. */
export function ReplayBadge({ replay, models = [] }: { replay: boolean; models?: string[] }) {
  if (models.some((m) => m.startsWith("sim:"))) {
    return (
      <Pill
        tone="accent"
        title="Answered by the simulator: fake, schema-valid outputs at no cost. The numbers measure the system, not a model."
      >
        Simulated
      </Pill>
    );
  }
  if (!replay) return null;
  return (
    <Pill
      tone="warning"
      title="Served from recorded cassettes: costs are as recorded, latencies are the recorded live latencies, nothing was spent."
    >
      Replay
    </Pill>
  );
}

export function FrozenBadge({ frozen }: { frozen: boolean }) {
  if (!frozen) return null;
  return <Pill tone="info">frozen</Pill>;
}

export function Tile({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <StatCard label={label} value={children} />
    </div>
  );
}

const TABS = [
  { href: "/evals", label: "Runs" },
  { href: "/evals/datasets", label: "Datasets" },
  { href: "/evals/configs", label: "Configs" },
  { href: "/evals/production", label: "Production" },
];

/** Links, not buttons: each tab is a page of its own. */
export function EvalsTabs({ active }: { active: string }) {
  return (
    <nav
      aria-label="Evals pages"
      className="mt-4 flex gap-1 overflow-x-auto [scrollbar-width:none] shadow-[inset_0_-1px_0_var(--border)]"
    >
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active === t.href ? "page" : undefined}
          className={`inline-flex h-9 items-center border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
            active === t.href
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function EvalsPage({ active, children, intro }: { active: string; children: ReactNode; intro: string }) {
  return (
    <Page>
      <PageHeader title="Evals" description={intro} />
      <EvalsTabs active={active} />
      {children}
    </Page>
  );
}
