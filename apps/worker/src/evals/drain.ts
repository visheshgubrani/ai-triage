import { type EvalItemJob, QUEUE_OPTIONS, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import type { EvalDeps } from "./deps";
import { failedEvalItem, runEvalItem } from "./run-item";

/**
 * Runs one tenant's queued eval items in-process until none are left: tests and scripts use it in
 * place of registerEvals(). Emulates pg-boss retries and the dead letter, like drainTenantJobs.
 * The boss is passed separately: EvalDeps has no queue.
 */
export async function drainEvalJobs(
  deps: EvalDeps,
  boss: PgBoss,
  tenantId: string,
  options: { maxRounds?: number; concurrency?: number } = {},
) {
  const queue = QUEUES.evalItem;
  const failures = new Map<string, number>();
  for (let round = 0; round < (options.maxRounds ?? 1000); round++) {
    const jobs = await boss.findJobs<EvalItemJob>(queue, { data: { tenantId }, queued: true });
    if (jobs.length === 0) return;
    const pending = [...jobs];
    const run = async () => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        try {
          await runEvalItem(deps, job.data);
          await boss.deleteJob(queue, job.id);
        } catch (err) {
          const count = (failures.get(job.id) ?? 0) + 1;
          failures.set(job.id, count);
          if (count > QUEUE_OPTIONS[queue].retryLimit) {
            await boss.deleteJob(queue, job.id);
            await failedEvalItem(deps, job.data, { output: { message: (err as Error).message } });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, run));
  }
  throw new Error(`drainEvalJobs: jobs still queued after ${options.maxRounds ?? 1000} rounds`);
}
