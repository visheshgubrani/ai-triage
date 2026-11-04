"use client";

import type { ProductionResponse } from "@ai-triage/contracts";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { humanize } from "@/lib/format";

const DAY_MS = 86_400_000;
/** Eight chart slots: a ninth category folds into "Other" rather than inventing a hue. */
const MAX_SERIES = 8;
const OTHER = "other_categories";

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Stacks one bar per day. Categories sort by name, so a category keeps its colour as others come and go. */
export function DocumentsChart({
  rows,
  since,
  until,
}: {
  rows: ProductionResponse["costByDay"];
  since: string;
  until: string;
}) {
  const { data, series, config } = useMemo(() => {
    const names = [...new Set(rows.map((r) => r.category))].sort();
    const shown = names.length > MAX_SERIES ? names.slice(0, MAX_SERIES - 1) : names;
    const series = names.length > MAX_SERIES ? [...shown, OTHER] : shown;
    const byDay = new Map<string, Record<string, number>>();
    for (let t = Date.parse(since.slice(0, 10)); t <= Date.parse(until); t += DAY_MS) {
      byDay.set(new Date(t).toISOString().slice(0, 10), {});
    }
    for (const r of rows) {
      const counts = byDay.get(r.day);
      if (!counts) continue;
      const key = shown.includes(r.category) ? r.category : OTHER;
      counts[key] = (counts[key] ?? 0) + r.documents;
    }
    return {
      series,
      data: [...byDay].map(([day, counts]) => ({ day, ...counts })),
      config: Object.fromEntries(
        series.map((name, i) => [
          name,
          { label: name === OTHER ? "Other" : humanize(name), color: `var(--chart-${i + 1})` },
        ]),
      ) as ChartConfig,
    };
  }, [rows, since, until]);

  if (rows.length === 0) {
    return <p className="py-10 text-center text-muted-foreground">No documents processed in this period.</p>;
  }
  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-64 w-full"
      role="img"
      aria-label="Documents processed per day, by category"
    >
      <BarChart data={data} margin={{ top: 4, right: 0, left: -20, bottom: 0 }} maxBarSize={24}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={dayLabel}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={48} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={<ChartTooltipContent labelFormatter={(value) => dayLabel(String(value))} />}
        />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((name, i) => (
          <Bar
            key={name}
            dataKey={name}
            stackId="documents"
            fill={`var(--color-${name})`}
            stroke="var(--card)"
            strokeWidth={2}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
