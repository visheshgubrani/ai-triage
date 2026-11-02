import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
