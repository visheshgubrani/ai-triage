import { createApiClient } from "@ai-triage/api/client";

/**
 * For server components: forward the browser's cookie header explicitly on each call. The server
 * reaches the API directly (in Docker, `http://api:8787`), not through the public origin.
 */
export const api = createApiClient(`${process.env.API_INTERNAL_URL ?? "http://localhost:8787"}/api`);

/**
 * For client components: the API is this origin's /api (Caddy routes it; `pnpm dev` rewrites it),
 * so the session cookie goes along like on any same-origin request.
 */
export const browserApi = createApiClient("/api");
