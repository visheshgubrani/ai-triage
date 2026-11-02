import { LLM_STAGES, PIPELINE_STAGES, QUEUES, STAGE_QUEUES, type StageJob } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import type { PipelineDeps } from "./deps";
import { failedStage, runStage } from "./stages";

/** Subscribes the stage handlers and the dead-letter handler. LLM stages share a concurrency limit. */
export async function registerPipeline(boss: PgBoss, deps: PipelineDeps, options: { llmConcurrency: number }) {
  for (const stage of PIPELINE_STAGES) {
    const llm = (LLM_STAGES as readonly string[]).includes(stage);
    await boss.work<StageJob>(
      STAGE_QUEUES[stage],
      { localConcurrency: llm ? options.llmConcurrency : 2 },
      async ([job]) => {
        if (job) await runStage(deps, stage, job.data);
      },
    );
  }
  // No explicit type argument here: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(QUEUES.failed, { includeMetadata: true }, async ([job]) => {
    if (job) await failedStage(deps, job.data as StageJob, { queue: job.sourceName, output: job.sourceOutput });
  });
}
