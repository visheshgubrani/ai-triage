import { createLogger, logLevelFromEnv, Registry } from "@ai-triage/telemetry";

// The api's logger and metrics (docs/operations.md). Lines carry the request's trace id, which is
// also its request id and goes into every job the request enqueues.
export const log = createLogger({ service: "api", level: logLevelFromEnv() });

export const registry = new Registry();
export const httpRequests = registry.counter("triage_http_requests_total", "Requests by method, route and status.");
export const httpSeconds = registry.histogram("triage_http_request_seconds", "Request duration by route.");
