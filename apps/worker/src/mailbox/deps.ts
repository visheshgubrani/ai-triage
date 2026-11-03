import type { KeyRing, PgBoss, Pool } from "@ai-triage/db";
import type { GoogleDeps } from "@ai-triage/mailbox";
import type { Storage } from "@ai-triage/storage";

export interface MailboxDeps {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  /** Decrypts and encrypts mailbox tokens (ENCRYPTION_KEYS). */
  keys: KeyRing;
  /** Google's client and the fetch that reaches it; null when the instance has none (nothing syncs). */
  google: GoogleDeps | null;
  limits: {
    /** MAX_FILE_MB: per attachment, as for every email. */
    maxFileBytes: number;
    /** New messages one sync of a mailbox takes; the rest follow at the next poll. */
    syncBatch: number;
    /** Inbound email per tenant per hour, shared with Postmark (RATE_LIMIT_SCALE applies). */
    inboundPerHour: number;
  };
  now: () => Date;
}
