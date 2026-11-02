import { createApiClient } from "@ai-triage/api/client";

export const api = createApiClient(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787");
