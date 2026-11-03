import type { Rate } from "@ai-triage/evals";
import Link from "next/link";

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
  if (rate.n === 0) return <span className="text-neutral-400">{empty} (n=0)</span>;
  return (
    <span title={`${rate.k} of ${rate.n}; 95% Wilson lower bound ${pct(rate.lower, 1)}`} className="tabular-nums">
      {pct(rate.rate)}{" "}
      <span className="text-neutral-500">
        {rate.k}/{rate.n} ≥{pct(rate.lower)}
      </span>
    </span>
  );
}

export function ReplayBadge({ replay }: { replay: boolean }) {
  if (!replay) return null;
  return (
    <span
      title="Served from recorded cassettes: costs are as recorded, latencies are the recorded live latencies, nothing was spent."
      className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
    >
      Replay
    </span>
  );
}

export function FrozenBadge({ frozen }: { frozen: boolean }) {
  if (!frozen) return null;
  return (
    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
      frozen
    </span>
  );
}

export const tableClass = "w-full text-left text-sm [&_td]:py-1 [&_td]:pr-4 [&_th]:pb-1 [&_th]:pr-4 [&_th]:font-medium";
export const headClass = "text-xs text-neutral-500";

export function Tile({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" title={hint}>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{children}</div>
    </div>
  );
}

const TABS = [
  { href: "/evals", label: "Runs" },
  { href: "/evals/datasets", label: "Datasets" },
  { href: "/evals/configs", label: "Configs" },
  { href: "/evals/production", label: "Production" },
];

export function EvalsTabs({ active }: { active: string }) {
  return (
    <div className="mt-4 flex gap-4 border-b border-neutral-200 dark:border-neutral-800">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-1 pb-2 text-sm ${
            active === t.href
              ? "border-neutral-900 font-medium dark:border-neutral-100"
              : "border-transparent text-neutral-500"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function EvalsPage({ active, children, intro }: { active: string; children: React.ReactNode; intro: string }) {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Evals</h1>
      <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">{intro}</p>
      <EvalsTabs active={active} />
      {children}
    </main>
  );
}
