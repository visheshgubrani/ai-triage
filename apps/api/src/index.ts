import { serve } from "@hono/node-server";
import { app, pool } from "./app";

const port = Number(process.env.API_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
