import {
  AcceptWithPasswordRequest,
  CreateInvitationRequest,
  type ErrorResponse,
  type Invitation,
  type InvitationAccepted,
  type InvitationCreated,
  type InvitationPreview,
  InvitationTokenRequest,
  type MemberList,
  UpdateMemberRequest,
} from "@ai-triage/contracts";
import type { MemberErrorCode } from "@ai-triage/core";
import {
  acceptInvitation,
  acceptInvitationWithPassword,
  changeMemberRole,
  createInvitation,
  type Invitation as InvitationRow,
  listInvitations,
  listMembers,
  previewInvitation,
  removeMember,
  revokeInvitation,
  setSessionTenant,
  withTenantTx,
} from "@ai-triage/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { userActor } from "../audit";
import { clientIp } from "../client-ip";
import type { AppDeps } from "../deps";
import { limitUserWrites, overLimit } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

export const MEMBER_ERROR_STATUS: Record<MemberErrorCode, 403 | 404 | 409 | 410> = {
  last_admin: 409,
  already_member: 409,
  user_exists: 409,
  not_member: 404,
  invitation_invalid: 410,
  email_mismatch: 403,
  email_not_verified: 403,
  password_not_allowed: 403,
};

const userIdParam = zValidator("param", z.object({ userId: z.uuid() }), (result, c) => {
  if (!result.success) return c.json({ error: "Not found" }, 404);
});

const toInvitation = (i: InvitationRow): Invitation => ({
  ...i,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

/** The invite page reads the token from the URL fragment, which never reaches a server log or a Referer. */
export const invitationLink = (webOrigin: string, token: string) => `${webOrigin}/invite#${token}`;

/**
 * Members and invitations of the tenant (admins only). Removing a member or changing a role keeps
 * at least one admin; every change is audited.
 */
export const memberRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), requireRole("admin"), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/", async (c) => {
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<MemberList> => {
        const members = await listMembers(tx);
        const invitations = await listInvitations(tx, deps.now());
        return {
          members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
          invitations: invitations.map(toInvitation),
          workspaceDomain: null,
          google: deps.google !== null,
        };
      });
      return c.json(body, 200);
    })
    .patch("/:userId", userIdParam, validate("json", UpdateMemberRequest), async (c) => {
      const { userId } = c.req.valid("param");
      const { role } = c.req.valid("json");
      await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        changeMemberRole(tx, userActor(c, deps), userId, role),
      );
      return c.body(null, 204);
    })
    .delete("/:userId", userIdParam, async (c) => {
      const { userId } = c.req.valid("param");
      await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => removeMember(tx, userActor(c, deps), userId));
      return c.body(null, 204);
    })
    .post("/invitations", validate("json", CreateInvitationRequest), async (c) => {
      const { email, role, acceptWith } = c.req.valid("json");
      if (acceptWith === "google" && !deps.google) {
        const body: ErrorResponse = {
          error: "Google sign-in isn't set up on this instance: invite with a password instead.",
          issues: [{ field: "acceptWith", path: "/acceptWith", message: "needs Google sign-in" }],
        };
        return c.json(body, 422);
      }
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<InvitationCreated> => {
        const created = await createInvitation(tx, userActor(c, deps), {
          email,
          role,
          acceptWith,
          inviterId: c.var.tenant.user.id,
          now: deps.now(),
        });
        return { invitation: toInvitation(created.invitation), link: invitationLink(deps.webOrigin, created.token) };
      });
      return c.json(body, 201);
    })
    .post("/invitations/:id/revoke", idParam, async (c) => {
      const { id } = c.req.valid("param");
      await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => revokeInvitation(tx, userActor(c, deps), id));
      return c.body(null, 204);
    });

/**
 * The invite page's endpoints, usable before the person is a member (rate-limited per address):
 * look an invitation up, accept it signed in (Google, or an existing account), or accept it by
 * creating a password account when the invitation allows that. The token travels in the body.
 */
export const invitationRoutes = (deps: AppDeps) =>
  new Hono()
    .use(async (c, next) => {
      const ip = clientIp(c, deps.trustedProxies) ?? "unknown";
      const refused = await overLimit(c, deps, deps.rateLimits.invitationsPerIp, `ip:${ip}:invitations`);
      if (refused) return refused;
      await next();
    })
    .post("/lookup", validate("json", InvitationTokenRequest), async (c) => {
      const preview = await previewInvitation(deps.db, c.req.valid("json").token, deps.now());
      if (!preview) {
        const body: ErrorResponse = {
          error: "This invitation link is invalid, used or expired",
          code: "invitation_invalid",
        };
        return c.json(body, 410);
      }
      const body: InvitationPreview = {
        ...preview,
        expiresAt: preview.expiresAt.toISOString(),
        google: deps.google !== null,
      };
      return c.json(body, 200);
    })
    .post("/accept", validate("json", InvitationTokenRequest), async (c) => {
      const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "Not signed in" }, 401);
      const { user } = session;
      const { tenantId } = await acceptInvitation(
        deps.db,
        c.req.valid("json").token,
        { id: user.id, email: user.email, emailVerified: user.emailVerified },
        {
          type: "user",
          id: user.id,
          label: user.email,
          ip: clientIp(c, deps.trustedProxies),
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId"),
        },
        deps.now(),
      );
      // The session now acts in the workspace that was just joined.
      await setSessionTenant(deps.db, session.session.token, tenantId);
      const body: InvitationAccepted = { tenantId, email: user.email };
      return c.json(body, 200);
    })
    .post("/accept-password", validate("json", AcceptWithPasswordRequest), async (c) => {
      const { token, name, password } = c.req.valid("json");
      const accepted = await acceptInvitationWithPassword(
        deps.db,
        token,
        { name, password },
        {
          ip: clientIp(c, deps.trustedProxies),
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId"),
        },
        deps.now(),
      );
      const body: InvitationAccepted = accepted;
      return c.json(body, 201);
    });
