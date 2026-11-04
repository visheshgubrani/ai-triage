import { LLM_STAGES, PIPELINE_STAGES, QUEUES, STAGE_QUEUES, type StageJob } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import { jobSignal } from "../shutdown";
import type { PipelineDeps } from "./deps";
import { failedStage, runStage } from "./stages";

/** Poll often: a document passes through four queues, and the default 2 s poll would dominate latency. */
const POLLING_INTERVAL_SECONDS = 0.5;

/** Subscribes the stage handlers and the dead-letter handler. LLM stages share a concurrency limit. */
export async function registerPipeline(boss: PgBoss, deps: PipelineDeps, options: { llmConcurrency: number }) {
  for (const stage of PIPELINE_STAGES) {
    const llm = (LLM_STAGES as readonly string[]).includes(stage);
    await boss.work<StageJob>(
      STAGE_QUEUES[stage],
      { localConcurrency: llm ? options.llmConcurrency : 4, pollingIntervalSeconds: POLLING_INTERVAL_SECONDS },
      async ([job]) => {
        if (job) await runStage(deps, stage, job.data, jobSignal(job));
      },
    );
  }
  // No explicit type argument here: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(
    QUEUES.failed,
    { includeMetadata: true, pollingIntervalSeconds: POLLING_INTERVAL_SECONDS },
    async ([job]) => {
      if (job) await failedStage(deps, job.data as StageJob, { queue: job.sourceName, output: job.sourceOutput });
    },
  );
}
