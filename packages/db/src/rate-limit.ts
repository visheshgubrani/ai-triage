import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./index";
import { rateLimitHits } from "./schema";

// Fixed-window rate limiting in Postgres (docs/security.md): one upsert per request, atomic across
// api processes. A fixed window can let up to twice the limit through around a window boundary,
// which is fine for abuse control.

export interface RateLimitHit {
  count: number;
  /** When the current window ends (for Retry-After). */
  resetAt: Date;
}

/** Counts one request in `bucket` for the window containing `now`, and returns the new count. */
export async function hitRateLimit(db: Db, bucket: string, windowSeconds: number, now: Date): Promise<RateLimitHit> {
  const windowMs = windowSeconds * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimitHits)
    .values({ bucket, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitHits.bucket, rateLimitHits.windowStart],
      set: { count: sql`${rateLimitHits.count} + 1` },
    })
    .returning({ count: rateLimitHits.count });
  return { count: row?.count ?? 1, resetAt: new Date(start.getTime() + windowMs) };
}

/** Takes back one count from the window containing `now` (an attempt that was refused and requeued). */
export async function releaseRateLimitHit(db: Db, bucket: string, windowSeconds: number, now: Date): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  await db
    .update(rateLimitHits)
    .set({ count: sql`greatest(${rateLimitHits.count} - 1, 0)` })
    .where(and(eq(rateLimitHits.bucket, bucket), eq(rateLimitHits.windowStart, start)));
}

/** Deletes windows that ended before `before` (worker cron). */
export async function pruneRateLimits(db: Db, before: Date): Promise<void> {
  await db.delete(rateLimitHits).where(lt(rateLimitHits.windowStart, before));
}
