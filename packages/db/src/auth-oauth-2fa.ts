import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";

// Better Auth's twoFactor plugin asks for the TOTP code only after an email/password sign-in (its
// after-hook matches /sign-in/email). A Google sign-in would otherwise skip it, so this hook does
// the same thing after an OAuth callback: drop the session that was just created, start a pending
// 2FA sign-in, and send the browser to the sign-in page to enter the code.
//
// It writes the plugin's own cookie and verification rows (better-auth/dist/plugins/two-factor:
// index.mjs, the sign-in hook, and verify-two-factor.mjs, which reads them), so the stock
// /two-factor/verify-totp and /two-factor/verify-backup-code endpoints finish the sign-in. Those
// names are internals: keep better-auth pinned, and auth-oauth-2fa.db.test.ts fails if they move.

/** The twoFactor plugin's cookie (TWO_FACTOR_COOKIE_NAME) and how long a pending sign-in lasts. */
const TWO_FACTOR_COOKIE = "two_factor";
const PENDING_SECONDS = 600;

export function oauthTwoFactor(options: { pendingURL: string }) {
  return {
    id: "oauth-two-factor",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path?.startsWith("/callback/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created?.user.twoFactorEnabled) return;
            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(created.session.token);
            ctx.context.setNewSession(null);

            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge: PENDING_SECONDS });
            const identifier = `2fa-${generateRandomString(20)}`;
            const expiresAt = new Date(Date.now() + PENDING_SECONDS * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: created.user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
            throw ctx.redirect(options.pendingURL);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
