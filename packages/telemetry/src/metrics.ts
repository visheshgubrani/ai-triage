// Prometheus metrics (text exposition format 0.0.4) without a client library: counters, gauges and
// histograms with labels, rendered by /api/metrics and the worker's /metrics.

type Labels = Record<string, string | number>;

const escapeLabel = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(String(labels[k]))}"`)
    .join(",");
const braces = (inner: string) => (inner ? `{${inner}}` : "");

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values].map(([k, v]) => `${this.name}${braces(k)} ${v}`),
    ];
  }
}

export class Gauge implements Metric {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
  /** Replaces every series at once (a sampled snapshot, where a series that vanished must go too). */
  replace(series: { labels: Labels; value: number }[]): void {
    this.values = new Map(series.map((s) => [key(s.labels), s.value]));
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      ...[...this.values].map(([k, v]) => `${this.name}${braces(k)} ${v}`),
    ];
  }
}

/** Seconds-scale default buckets, from a fast parse to a slow model call. */
export const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export class Histogram implements Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {}
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((le, i) => {
      if (value <= le && s) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count++;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : "";
      this.buckets.forEach((le, i) => {
        out.push(`${this.name}_bucket{${sep}le="${le}"} ${s.counts[i]}`);
      });
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${braces(k)} ${s.sum}`);
      out.push(`${this.name}_count${braces(k)} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private get<M extends Metric>(name: string, make: () => M): M {
    const existing = this.metrics.get(name);
    if (existing) return existing as M;
    const metric = make();
    this.metrics.set(name, metric);
    return metric;
  }
  counter(name: string, help: string): Counter {
    return this.get(name, () => new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.get(name, () => new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.get(name, () => new Histogram(name, help, buckets));
  }
  render(): string {
    return `${[...this.metrics.values()].flatMap((m) => m.render()).join("\n")}\n`;
  }
}

/** Prometheus's content type for the text format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
