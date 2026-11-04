import type { ErrorResponse } from "@ai-triage/contracts";
import type { Context, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";

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

/** One line per request: method, path (no query string), status, time and request id. */
export const requestLog = () =>
  createMiddleware(async (c: Context, next: Next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms req=${c.get("requestId")}`);
  });
