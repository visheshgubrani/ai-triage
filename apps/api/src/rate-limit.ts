import type { ErrorResponse } from "@ai-triage/contracts";
import { hitRateLimit } from "@ai-triage/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "./deps";
import type { TenantEnv } from "./tenant";

// Abuse controls (docs/security.md, M4): fixed-window limits counted in Postgres, so every api
// process shares them. Better Auth's own limiter is off (packages/db/src/auth.ts): it is per process
// and, without a proxy header, puts every client in one bucket.

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

/** Defaults; RATE_LIMIT_SCALE multiplies every `max` (a busy instance raises them all at once). */
export const RATE_LIMITS = {
  /** Sign-in attempts from one address, and against one account (password guessing). */
  signInPerIp: { max: 10, windowSeconds: 60 },
  signInPerEmail: { max: 10, windowSeconds: 15 * 60 },
  /** Any other Better Auth endpoint, per address. */
  authPerIp: { max: 120, windowSeconds: 60 },
  /** Inbound email per tenant: Postmark sends from shared addresses, so the tenant is the key. */
  postmarkPerTenant: { max: 500, windowSeconds: 60 * 60 },
  /** The REST API, per key. */
  apiPerKey: { max: 120, windowSeconds: 60 },
  /** Upload presigns and completions, per user. */
  uploadsPerUser: { max: 60, windowSeconds: 60 },
  /** Every other cookie-authenticated write, per user. */
  writesPerUser: { max: 300, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

export type RateLimits = Record<keyof typeof RATE_LIMITS, RateLimitRule>;

export function rateLimitsFromEnv(env: Record<string, string | undefined>): RateLimits {
  const scale = Number(env.RATE_LIMIT_SCALE ?? 1);
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Object.fromEntries(
    Object.entries(RATE_LIMITS).map(([name, rule]) => [name, { ...rule, max: Math.ceil(rule.max * factor) }]),
  ) as RateLimits;
}

/**
 * Counts this request against `bucket` and returns a 429 response when it is over the limit (null
 * when it may proceed). Retry-After says when the window resets.
 */
export async function overLimit(
  c: Context,
  deps: AppDeps,
  rule: RateLimitRule,
  bucket: string,
): Promise<Response | null> {
  const hit = await hitRateLimit(deps.db, bucket, rule.windowSeconds, deps.now());
  if (hit.count <= rule.max) return null;
  const retryAfter = Math.max(1, Math.ceil((hit.resetAt.getTime() - deps.now().getTime()) / 1000));
  c.header("Retry-After", String(retryAfter));
  const body: ErrorResponse = { error: "Too many requests; try again later.", code: "rate_limited" };
  return c.json(body, 429);
}

/** A per-user limit on writes (unsafe methods). Use after requireTenant(). */
export const limitUserWrites = (deps: AppDeps, rule: RateLimitRule, name = "writes") =>
  createMiddleware<TenantEnv>(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const refused = await overLimit(c, deps, rule, `user:${c.var.tenant.user.id}:${name}`);
      if (refused) return refused;
    }
    await next();
  });
