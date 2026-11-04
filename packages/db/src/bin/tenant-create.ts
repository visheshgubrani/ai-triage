import { parseArgs } from "node:util";
import { INVITATION_ACCEPT_METHODS, type InvitationAcceptMethod, isOneOf, resolvePublicUrls } from "@ai-triage/core";
import { createPool, createWorkspace, SYSTEM_ACTOR } from "../index";

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
  const { token } = await createWorkspace(pool, {
    name,
    slug,
    adminEmail: admin,
    acceptWith: acceptWith as InvitationAcceptMethod,
    actor: SYSTEM_ACTOR("cli: tenant:create"),
    inboundDomain: process.env.INBOUND_DOMAIN || undefined,
    now: new Date(),
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
