import { type EvalItemJob, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import { jobSignal } from "../shutdown";
import type { EvalDeps } from "./deps";
import { failedEvalItem, runEvalItem } from "./run-item";

/** Subscribes the eval item handler and its dead letter. The boss is only for receiving jobs. */
export async function registerEvals(boss: PgBoss, deps: EvalDeps, options: { concurrency: number }) {
  await boss.work<EvalItemJob>(
    QUEUES.evalItem,
    { localConcurrency: options.concurrency, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (job) await runEvalItem(deps, job.data, jobSignal(job));
    },
  );
  // No explicit type argument here: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(QUEUES.evalFailed, { includeMetadata: true, pollingIntervalSeconds: 1 }, async ([job]) => {
    if (job) await failedEvalItem(deps, job.data as EvalItemJob, { output: job.sourceOutput });
  });
}
