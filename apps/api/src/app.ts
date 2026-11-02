import type { HealthResponse } from "@ai-triage/contracts";
import { createDb, createPool, pingDb } from "@ai-triage/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const pool = createPool();
const db = createDb(pool);

export const app = new Hono()
  .use(logger())
  .use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" }))
  .get("/health", async (c) => {
    const dbUp = await pingDb(db);
    const body: HealthResponse = {
      status: dbUp ? "ok" : "degraded",
      db: dbUp ? "up" : "down",
      time: new Date().toISOString(),
    };
    return c.json(body, dbUp ? 200 : 503);
  });

export type AppType = typeof app;
export { pool };
