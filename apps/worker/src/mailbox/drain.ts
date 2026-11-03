import { type MailboxFetchJob, type MailboxSyncJob, QUEUE_OPTIONS, QUEUES } from "@ai-triage/core";
import type { MailboxDeps } from "./deps";
import { fetchFailed, fetchMessage } from "./fetch";
import { syncMailbox } from "./sync";

/**
 * Runs one tenant's queued mailbox jobs in-process (syncs, then fetches) until none are left that
 * are due. For tests and the demo seed; production uses registerMailbox(). Emulates pg-boss's
 * retries and dead letter for fetches. Deferred fetches (startAfter in the future) are left queued.
 */
export async function drainMailboxJobs(deps: MailboxDeps, tenantId: string, options: { maxRounds?: number } = {}) {
  const failures = new Map<string, number>();
  const due = (job: { startAfter: Date }) => job.startAfter.getTime() <= Date.now();
  for (let round = 0; round < (options.maxRounds ?? 100); round++) {
    let ran = 0;
    const syncs = await deps.boss.findJobs<MailboxSyncJob>(QUEUES.mailboxSync, { data: { tenantId }, queued: true });
    for (const job of syncs) {
      ran++;
      await syncMailbox(deps, job.data);
      await deps.boss.deleteJob(QUEUES.mailboxSync, job.id);
    }
    const fetches = await deps.boss.findJobs<MailboxFetchJob>(QUEUES.mailboxFetch, {
      data: { tenantId },
      queued: true,
    });
    for (const job of fetches.filter(due)) {
      ran++;
      try {
        await fetchMessage(deps, job.data);
        await deps.boss.deleteJob(QUEUES.mailboxFetch, job.id);
      } catch (err) {
        const count = (failures.get(job.id) ?? 0) + 1;
        failures.set(job.id, count);
        if (count > QUEUE_OPTIONS[QUEUES.mailboxFetch].retryLimit) {
          await deps.boss.deleteJob(QUEUES.mailboxFetch, job.id);
          await fetchFailed(deps, job.data);
        } else if (!(err instanceof Error)) throw err;
      }
    }
    if (ran === 0) return;
  }
  throw new Error(`drainMailboxJobs: jobs still queued after ${options.maxRounds ?? 100} rounds`);
}
