import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Fixed-window request counters (docs/security.md, abuse controls), shared by every api process.
 * Global, not a tenant table: buckets name what they count (an IP, a user, an API key, a tenant)
 * and are only ever touched by the rate limiter. Old windows are deleted by a daily worker cron.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ name: "rate_limit_hits_pkey", columns: [t.bucket, t.windowStart] })],
);
