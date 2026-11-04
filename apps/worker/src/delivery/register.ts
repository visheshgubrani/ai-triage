import { type DeliverJob, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import { tenantCap } from "../config";
import { deliverAction, deliveryFailed } from "./deliver";
import type { DeliveryDeps } from "./deps";

/** Subscribes webhook delivery and its dead-letter handler. */
export async function registerDelivery(
  boss: PgBoss,
  deps: DeliveryDeps,
  options: { tenantConcurrency: number | null } = { tenantConcurrency: null },
) {
  await boss.work<DeliverJob>(
    QUEUES.deliver,
    { localConcurrency: 4, pollingIntervalSeconds: 1, ...tenantCap(options.tenantConcurrency) },
    async ([job]) => {
      if (job) await deliverAction(deps, job.data);
    },
  );
  // No explicit type argument: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(QUEUES.deliveryFailed, { includeMetadata: true, pollingIntervalSeconds: 1 }, async ([job]) => {
    if (job) await deliveryFailed(deps, job.data as DeliverJob, { output: job.sourceOutput });
  });
}
