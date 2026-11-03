import { MAILBOX_POLL_CRON, type MailboxFetchJob, type MailboxSyncJob, QUEUES } from "@ai-triage/core";
import type { PgBoss } from "@ai-triage/db";
import type { MailboxDeps } from "./deps";
import { fetchFailed, fetchMessage } from "./fetch";
import { pollMailboxes, syncMailbox } from "./sync";

/** Schedules the minute poll (pg-boss keeps one schedule per queue) and subscribes the mailbox queues. */
export async function registerMailbox(boss: PgBoss, deps: MailboxDeps, options: { fetchConcurrency: number }) {
  await boss.schedule(QUEUES.mailboxPoll, MAILBOX_POLL_CRON, {}, { tz: "UTC" });
  await boss.work(QUEUES.mailboxPoll, async () => {
    await pollMailboxes(deps);
  });
  await boss.work<MailboxSyncJob>(
    QUEUES.mailboxSync,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (job) await syncMailbox(deps, job.data);
    },
  );
  await boss.work<MailboxFetchJob>(
    QUEUES.mailboxFetch,
    { localConcurrency: options.fetchConcurrency, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (job) await fetchMessage(deps, job.data);
    },
  );
  // No explicit type argument: it would stop TypeScript inferring the metadata-bearing job type.
  await boss.work(QUEUES.mailboxFailed, { includeMetadata: true, pollingIntervalSeconds: 1 }, async ([job]) => {
    if (job) await fetchFailed(deps, job.data as MailboxFetchJob);
  });
}
