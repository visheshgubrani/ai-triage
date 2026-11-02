import { MEMBER_ROLES } from "@ai-triage/core";
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const MemberRole = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRole>;

/** GET /me: the signed-in user and the tenant their session is acting in. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  role: MemberRole,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
