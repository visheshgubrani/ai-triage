import { type DeliverJob, QUEUE_OPTIONS, QUEUES } from "@ai-triage/core";
import { deliverAction, deliveryFailed } from "./deliver";
import type { DeliveryDeps } from "./deps";

/**
 * Runs one tenant's queued deliveries in-process until none are left, emulating pg-boss retries
 * (without the delays) and the dead letter. For tests and the replay e2e; production uses
 * registerDelivery().
 */
export async function drainDeliveries(deps: DeliveryDeps, tenantId: string, options: { maxRounds?: number } = {}) {
  const queue = QUEUES.deliver;
  const failures = new Map<string, number>();
  for (let round = 0; round < (options.maxRounds ?? 100); round++) {
    const jobs = await deps.boss.findJobs<DeliverJob>(queue, { data: { tenantId }, queued: true });
    if (jobs.length === 0) return;
    for (const job of jobs) {
      try {
        await deliverAction(deps, job.data);
        await deps.boss.deleteJob(queue, job.id);
      } catch (err) {
        const count = (failures.get(job.id) ?? 0) + 1;
        failures.set(job.id, count);
        if (count > QUEUE_OPTIONS[queue].retryLimit) {
          await deps.boss.deleteJob(queue, job.id);
          await deliveryFailed(deps, job.data, { output: { message: (err as Error).message } });
        }
      }
    }
  }
  throw new Error(`drainDeliveries: jobs still queued after ${options.maxRounds ?? 100} rounds`);
}
