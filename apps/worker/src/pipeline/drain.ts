import { PIPELINE_STAGES, QUEUE_OPTIONS, STAGE_QUEUES, type StageJob } from "@ai-triage/core";
import type { PipelineDeps } from "./deps";
import { failedStage, runStage } from "./stages";

/**
 * Runs one tenant's queued pipeline jobs in-process, in stage order, until none are left. Used by
 * tests and the cassette recorder; production uses registerPipeline(). It emulates pg-boss
 * retries (a throwing job is retried up to its queue's retryLimit, then dead-lettered to
 * failedStage) and leaves `action.deliver` jobs alone. Other tenants' jobs are never touched.
 */
export async function drainTenantJobs(deps: PipelineDeps, tenantId: string, options: { maxRounds?: number } = {}) {
  const failures = new Map<string, number>();
  for (let round = 0; round < (options.maxRounds ?? 1000); round++) {
    let ran = 0;
    for (const stage of PIPELINE_STAGES) {
      const queue = STAGE_QUEUES[stage];
      const jobs = await deps.boss.findJobs<StageJob>(queue, { data: { tenantId }, queued: true });
      for (const job of jobs) {
        ran++;
        try {
          await runStage(deps, stage, job.data);
          await deps.boss.deleteJob(queue, job.id);
        } catch (err) {
          const count = (failures.get(job.id) ?? 0) + 1;
          failures.set(job.id, count);
          if (count > QUEUE_OPTIONS[queue].retryLimit) {
            await deps.boss.deleteJob(queue, job.id);
            await failedStage(deps, job.data, { queue, output: { message: (err as Error).message } });
          }
        }
      }
    }
    if (ran === 0) return;
  }
  throw new Error(`drainTenantJobs: jobs still queued after ${options.maxRounds ?? 1000} rounds`);
}
