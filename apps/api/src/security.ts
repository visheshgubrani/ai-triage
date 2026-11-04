import { timingSafeEqual } from "node:crypto";
import type { ErrorResponse } from "@ai-triage/contracts";
import { runWithTrace } from "@ai-triage/telemetry";
import type { Context, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { httpRequests, httpSeconds, log } from "./log";

// HTTP edge controls (docs/security.md): response headers, an Origin check on cookie-authenticated
// writes, a body limit for JSON routes, request ids in logs, and the Better Auth endpoints the web
// actually uses.

/**
 * Machine-to-machine routes: they authenticate with basic auth (Postmark) or an API key, never a
 * cookie, so they skip the Origin check, and they set their own (larger) body limit.
 */
const MACHINE_PREFIXES = ["/api/webhooks/", "/api/v1/", "/webhooks/", "/v1/"];
const isMachineRoute = (path: string) => MACHINE_PREFIXES.some((p) => path.startsWith(p));

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The JSON routes' body limit. Uploads go straight to storage, so nothing else needs more. */
export const JSON_BODY_LIMIT = 2 ** 20;

/** Headers for a JSON-only API: nothing may load, frame, sniff or follow a referrer from it. */
export const apiSecureHeaders = (options: { hsts: boolean }) =>
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
    strictTransportSecurity: options.hsts ? "max-age=31536000; includeSubDomains" : false,
  });

/**
 * CSRF defence for cookie sessions: a state-changing request must come from a trusted origin.
 * Browsers always send Origin on cross-origin and same-origin fetch POSTs, and SameSite=Lax alone
 * lets same-site pages (other ports, sibling subdomains) through.
 */
export const requireTrustedOrigin = (origins: readonly string[]) =>
  createMiddleware(async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && !isMachineRoute(c.req.path)) {
      const origin = c.req.header("origin");
      if (!origin || !origins.includes(origin)) {
        const body: ErrorResponse = { error: "Request origin not allowed", code: "bad_origin" };
        return c.json(body, 403);
      }
    }
    await next();
  });

const jsonLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT,
  onError: (c) => c.json({ error: "Payload too large" } satisfies ErrorResponse, 413),
});

/** The JSON body limit on every route except the machine ones, which set their own. */
export const limitJsonBodies = () =>
  createMiddleware(async (c, next) => (isMachineRoute(c.req.path) ? next() : jsonLimit(c, next)));

/**
 * Runs the request under its trace (its request id), so the jobs it enqueues and every line it logs
 * carry the id. Then one line per request: method, path (no query string), status and time, and the
 * HTTP metrics by route pattern (`/api/documents/:id`, never the ids themselves).
 */
export const requestLog = (options: { log: boolean } = { log: true }) =>
  createMiddleware(async (c: Context, next: Next) =>
    runWithTrace(c.get("requestId"), async () => {
      const start = performance.now();
      await next();
      const ms = Math.round(performance.now() - start);
      const route = routePath(c);
      httpRequests.inc({ method: c.req.method, route, status: c.res.status });
      httpSeconds.observe({ route }, ms / 1000);
      if (options.log) log.info("request", { method: c.req.method, path: c.req.path, status: c.res.status, ms });
    }),
  );

/**
 * Constant-time string comparison. Both sides are padded to the same length (timingSafeEqual needs
 * that), and the lengths are compared separately, so neither the content nor its length leaks
 * through timing beyond the longer side's length.
 */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  const size = Math.max(a.length, b.length);
  const padded = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc(size - buf.length)]);
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}
