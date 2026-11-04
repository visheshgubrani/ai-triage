import { type EvalItemJob, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import type { JobWithMetadata } from "pg-boss";
import { tenantCap } from "../config";
import { observed } from "../observe";
import { jobSignal } from "../shutdown";
import type { EvalDeps } from "./deps";
import { failedEvalItem, runEvalItem } from "./run-item";

/** Subscribes the eval item handler and its dead letter. The boss is only for receiving jobs. */
export async function registerEvals(
  boss: PgBoss,
  deps: EvalDeps,
  options: { concurrency: number; tenantConcurrency: number | null },
) {
  await boss.work<EvalItemJob>(
    QUEUES.evalItem,
    { localConcurrency: options.concurrency, pollingIntervalSeconds: 1, ...tenantCap(options.tenantConcurrency) },
    observed(QUEUES.evalItem, (job) => runEvalItem(deps, job.data, jobSignal(job))),
  );
  // No explicit type argument here: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(
    QUEUES.evalFailed,
    { includeMetadata: true, pollingIntervalSeconds: 1 },
    observed(QUEUES.evalFailed, (job: JobWithMetadata) =>
      failedEvalItem(deps, job.data as EvalItemJob, { output: job.sourceOutput }),
    ),
  );
}
