import { parseArgs } from "node:util";
import { INVITATION_ACCEPT_METHODS, type InvitationAcceptMethod, isOneOf, resolvePublicUrls } from "@ai-triage/core";
import {
  buildPipelineConfig,
  createInvitation,
  createPool,
  createTenant,
  recordAudit,
  SYSTEM_ACTOR,
  withTenantTx,
} from "../index";

// `pnpm tenant:create --name "Acme" --slug acme --admin you@acme.com [--accept-with google|google_or_password]`
//
// Creates a tenant with its settings, an active pipeline config (the built-in categories, every one
// reviewed by a human until an admin opts in) and, with INBOUND_DOMAIN set, a Postmark inbound
// address. Then invites the first admin and prints the invite link, which is shown only once. Runs
// as the app role (DATABASE_URL), through the same RLS as the API.

const usage =
  "usage: pnpm tenant:create --name <name> --slug <slug> --admin <email> [--accept-with google|google_or_password]";
const { values } = parseArgs({
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    admin: { type: "string" },
    "accept-with": { type: "string" },
  },
});
const { name, slug, admin } = values;
// Without a Google client, the admin can only accept with a password.
const googleConfigured = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
const acceptWith = values["accept-with"] ?? (googleConfigured ? "google" : "google_or_password");
if (!name || !slug || !admin || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || !admin.includes("@")) {
  console.error(usage);
  console.error("The slug is lowercase letters, digits and dashes.");
  process.exit(2);
}
if (!isOneOf(INVITATION_ACCEPT_METHODS, acceptWith)) {
  console.error(usage);
  process.exit(2);
}

const webOrigin = resolvePublicUrls(process.env).origin;
const pool = createPool();
try {
  const { id } = await createTenant(pool, { name, slug, inboundDomain: process.env.INBOUND_DOMAIN || undefined });
  const actor = SYSTEM_ACTOR("cli: tenant:create");
  const token = await withTenantTx(pool, id, async (tx) => {
    const config = await buildPipelineConfig(tx, { name: "Default config" });
    await recordAudit(tx, actor, {
      action: "config.created",
      target: { type: "config", id: config.id },
      details: { name: "Default config", activated: true },
    });
    const { token } = await createInvitation(tx, actor, {
      email: admin,
      role: "admin",
      acceptWith: acceptWith as InvitationAcceptMethod,
      inviterId: null,
      now: new Date(),
    });
    return token;
  });
  console.log(`Created tenant "${name}" (${slug}). Send this invite link to ${admin}; it is shown only once:\n`);
  console.log(`  ${webOrigin}/invite#${token}\n`);
  console.log(
    acceptWith === "google"
      ? "They accept it by signing in with the Google account for that email."
      : "They accept it with Google, or by choosing a password.",
  );
} finally {
  await pool.end();
}
