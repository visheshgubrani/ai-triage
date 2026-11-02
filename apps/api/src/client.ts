// Typed Hono RPC client for apps/web. Type-only dependency on the API.
import { hc } from "hono/client";
import type { AppType } from "./app";

export const createApiClient = (baseUrl: string, options?: Parameters<typeof hc>[1]) => hc<AppType>(baseUrl, options);
export type { AppType };
