import { describe, expect, it } from "vitest";
import { createLogger, Registry, runWithTrace } from "./index";

describe("logger", () => {
  const capture = () => {
    const lines: string[] = [];
    const log = createLogger({ service: "worker", pretty: false, write: (line) => lines.push(line) });
    return { log, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
  };

  it("writes one JSON object per line, with the trace of the work it's part of", () => {
    const { log, parsed } = capture();
    runWithTrace("req-1", () => log.child({ queue: "doc.parse" }).info("job done", { ms: 12, skipped: undefined }));
    expect(parsed()[0]).toMatchObject({
      level: "info",
      service: "worker",
      msg: "job done",
      trace: "req-1",
      queue: "doc.parse",
      ms: 12,
    });
    expect(parsed()[0]).not.toHaveProperty("skipped");
  });

  it("keeps an error's name, message and reason", () => {
    const { log, parsed } = capture();
    const err = Object.assign(new Error("bad pdf"), { name: "PipelineError", reason: "parse_error" });
    log.error("job failed", { err });
    expect(parsed()[0].err).toMatchObject({ name: "PipelineError", message: "bad pdf", reason: "parse_error" });
  });

  it("drops lines below its level", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "api", level: "warn", pretty: false, write: (l) => lines.push(l) });
    log.info("quiet");
    log.warn("loud");
    expect(lines).toHaveLength(1);
  });
});

describe("metrics", () => {
  it("renders counters, gauges and histograms in the Prometheus text format", () => {
    const r = new Registry();
    r.counter("triage_jobs_total", "Jobs.").inc({ queue: "doc.parse", outcome: "ok" });
    r.counter("triage_jobs_total", "Jobs.").inc({ queue: "doc.parse", outcome: "ok" });
    r.gauge("triage_queue_depth", "Depth.").replace([{ labels: { queue: 'a"b' }, value: 3 }]);
    r.histogram("triage_job_seconds", "Duration.", [1, 5]).observe({ queue: "doc.parse" }, 2);
    expect(r.render()).toBe(
      [
        "# HELP triage_jobs_total Jobs.",
        "# TYPE triage_jobs_total counter",
        'triage_jobs_total{outcome="ok",queue="doc.parse"} 2',
        "# HELP triage_queue_depth Depth.",
        "# TYPE triage_queue_depth gauge",
        'triage_queue_depth{queue="a\\"b"} 3',
        "# HELP triage_job_seconds Duration.",
        "# TYPE triage_job_seconds histogram",
        'triage_job_seconds_bucket{queue="doc.parse",le="1"} 0',
        'triage_job_seconds_bucket{queue="doc.parse",le="5"} 1',
        'triage_job_seconds_bucket{queue="doc.parse",le="+Inf"} 1',
        'triage_job_seconds_sum{queue="doc.parse"} 2',
        'triage_job_seconds_count{queue="doc.parse"} 1',
        "",
      ].join("\n"),
    );
  });
});
