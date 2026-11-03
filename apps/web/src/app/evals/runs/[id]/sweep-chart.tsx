import type { ThresholdSweep } from "@ai-triage/evals";
import { pct } from "../../ui";

// Threshold vs auto rate and auto-approval precision for one category, both on one 0–100% axis.
// The dashed line is precision's 95% Wilson lower bound: with few items it sits far below the point
// estimate, which is the honest reading. The table beside it carries the same numbers.

const W = 360;
const H = 180;
const PAD = { top: 10, right: 12, bottom: 26, left: 36 };

export function SweepChart({ sweep, chosen }: { sweep: ThresholdSweep; chosen: number | null }) {
  const points = sweep.points;
  if (points.length === 0) return <p className="text-xs text-neutral-500">No eligible items to sweep.</p>;
  const lo = Math.min(0.5, ...points.map((p) => p.threshold));
  const x = (t: number) => PAD.left + ((t - lo) / (1 - lo || 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v) * (H - PAD.top - PAD.bottom);
  const line = (values: (number | null)[]) =>
    points
      .map((p, i) => (values[i] === null ? null : `${x(p.threshold).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const auto = points.map((p) => p.autoRate.rate);
  const precision = points.map((p) => p.precision.rate);
  const lower = points.map((p) => (p.precision.n > 0 ? p.precision.lower : null));
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-md"
        role="img"
        aria-label={`Threshold sweep for ${sweep.category}`}
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              className="stroke-neutral-200 dark:stroke-neutral-800"
            />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-neutral-500 text-[9px]">
              {pct(v)}
            </text>
          </g>
        ))}
        {[lo, (lo + 1) / 2, 1].map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="fill-neutral-500 text-[9px]">
            {t.toFixed(2)}
          </text>
        ))}
        {chosen !== null && (
          <line
            x1={x(chosen)}
            x2={x(chosen)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="stroke-neutral-400"
            strokeDasharray="2 2"
          />
        )}
        <polyline points={line(auto)} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        <polyline points={line(precision)} fill="none" stroke="var(--series-2)" strokeWidth={2} />
        <polyline points={line(lower)} fill="none" stroke="var(--series-2)" strokeWidth={1.5} strokeDasharray="4 3" />
        {points.map((p) => (
          <g key={p.threshold}>
            <circle cx={x(p.threshold)} cy={y(p.autoRate.rate ?? 0)} r={4} fill="var(--series-1)">
              <title>{`threshold ${p.threshold.toFixed(3)}: auto ${p.autoRate.k}/${p.autoRate.n}`}</title>
            </circle>
            {p.precision.rate !== null && (
              <circle cx={x(p.threshold)} cy={y(p.precision.rate)} r={4} fill="var(--series-2)">
                <title>{`threshold ${p.threshold.toFixed(3)}: precision ${p.precision.k}/${p.precision.n}, ≥${pct(p.precision.lower)}`}</title>
              </circle>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 text-xs text-neutral-600 dark:text-neutral-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: "var(--series-1)" }} /> auto-approved
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: "var(--series-2)" }} /> precision
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "var(--series-2)" }} />{" "}
          precision, 95% lower bound
        </span>
      </figcaption>
    </figure>
  );
}
