import { type DeliverJob, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import type { JobWithMetadata } from "pg-boss";
import { tenantCap } from "../config";
import { observed } from "../observe";
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
    observed(QUEUES.deliver, (job) => deliverAction(deps, job.data)),
  );
  // No explicit type argument: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(
    QUEUES.deliveryFailed,
    { includeMetadata: true, pollingIntervalSeconds: 1 },
    observed(QUEUES.deliveryFailed, (job: JobWithMetadata) =>
      deliveryFailed(deps, job.data as DeliverJob, { output: job.sourceOutput }),
    ),
  );
}
