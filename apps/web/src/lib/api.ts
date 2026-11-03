import { createApiClient } from "@ai-triage/api/client";

const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * For server components: forward the browser's cookie header explicitly on each call. The server may
 * reach the API at another address than the browser does (in Docker, `http://api:8787`).
 */
export const api = createApiClient(process.env.API_INTERNAL_URL ?? baseUrl);

/** For client components: the API is another origin, so send the session cookie with every request. */
export const browserApi = createApiClient(baseUrl, { init: { credentials: "include" } });
