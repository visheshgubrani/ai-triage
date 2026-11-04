import {
  type OnboardingResponse,
  type OnboardingStep,
  SetupRequest,
  type SetupResponse,
  type SetupStatusResponse,
} from "@ai-triage/contracts";
import {
  claimSetup,
  completeSetup,
  createWorkspace,
  dismissOnboarding,
  type OnboardingFacts,
  onboardingFacts,
  recordAudit,
  releaseSetup,
  SYSTEM_ACTOR,
  setupNeeded,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import { clientIp } from "../client-ip";
import type { AppDeps } from "../deps";
import { log } from "../log";
import { overLimit } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";

// First run (docs/deploy.md): while no workspace exists, the api logs a one-time setup link; the
// setup page posts the token here to create the first workspace and its admin's invitation, then
// continues at the invite link like any invited member. Setup closes for good once it's used.

export const setupRoutes = (deps: AppDeps) =>
  new Hono()
    .get("/status", async (c) => {
      const body: SetupStatusResponse = { needed: await setupNeeded(deps.db), googleSignIn: deps.googleSignIn };
      return c.json(body, 200);
    })
    .post("/", validate("json", SetupRequest), async (c) => {
      const ip = clientIp(c, deps.trustedProxies) ?? "unknown";
      const limited = await overLimit(c, deps, deps.rateLimits.invitationsPerIp, `ip:${ip}:setup`);
      if (limited) return limited;
      const input = c.req.valid("json");
      const now = deps.now();
      // A token printed before someone ran tenant:create must not make a second workspace.
      if (!(await setupNeeded(deps.db)) || !(await claimSetup(deps.db, input.token, now))) {
        return c.json(
          { error: "This setup link isn't valid any more. Get a new one from the api's log.", code: "setup_closed" },
          403,
        );
      }
      try {
        const { tenantId, token } = await createWorkspace(deps.pool, {
          name: input.workspaceName,
          slug: input.slug,
          adminEmail: input.adminEmail,
          acceptWith: input.acceptWith,
          actor: SYSTEM_ACTOR("setup page"),
          inboundDomain: deps.inboundDomain ?? undefined,
          model: deps.defaultModel,
          now,
        });
        await completeSetup(deps.db, tenantId);
        await withTenantTx(deps.pool, tenantId, (tx) =>
          recordAudit(
            tx,
            { ...SYSTEM_ACTOR("setup page"), ip },
            {
              action: "setup.completed",
              details: { slug: input.slug, admin: input.adminEmail },
            },
          ),
        );
        log.info("first workspace created by the setup page", { slug: input.slug });
        const body: SetupResponse = { inviteUrl: `${deps.webOrigin}/invite#${token}` };
        return c.json(body, 201);
      } catch (err) {
        await releaseSetup(deps.db);
        const code = (err as { code?: string }).code;
        // 23505: the slug (or address) is taken.
        if (code === "23505") return c.json({ error: "That slug is taken; pick another.", code: "slug_taken" }, 409);
        throw err;
      }
    });

/** The getting-started checklist's steps, from the tenant's own data. */
function steps(f: OnboardingFacts): OnboardingStep[] {
  return [
    {
      id: "model",
      title: "Connect a model",
      done: f.modelBlocker === null,
      detail:
        f.modelBlocker === null
          ? "The active pipeline config can run on a running worker."
          : `Not yet: ${f.modelBlocker}. Set LLM_MODE=live and the provider's key on the worker, or pick a model in Settings → Pipeline.`,
      href: "/settings/pipeline",
    },
    {
      id: "categories",
      title: "Review your categories",
      done: f.customCategories > 0 || f.configVersions > 1,
      detail: "Invoices, support requests and contracts are built in. Add your own document types and fields.",
      href: "/settings/categories",
    },
    {
      id: "intake",
      title: "Connect intake",
      done: f.intakeConnected,
      detail: "Connect a Gmail mailbox, forward mail to the inbound address, create an API key, or upload a file.",
      href: "/settings",
    },
    {
      id: "first-document",
      title: "Process a first document",
      done: f.processed > 0,
      detail: f.documents > 0 ? `${f.documents} received, ${f.processed} processed.` : "Upload one under Documents.",
      href: "/documents",
    },
    {
      id: "webhook",
      title: "Send approvals to your systems",
      done: f.webhookSet && f.webhookVerified,
      detail: f.webhookSet
        ? "Send a test event to check that your receiver verifies the signature."
        : "Set a webhook URL: every approved document is POSTed there, signed.",
      href: "/settings",
    },
    {
      id: "team",
      title: "Invite your team",
      done: f.members > 1 || f.pendingInvitations > 0,
      detail: "Reviewers decide what the model isn't sure about.",
      href: "/settings/members",
    },
    {
      id: "automation",
      title: "Measure, then automate",
      done: f.automating && f.frozenConfigs > 0,
      detail:
        f.labeledItems < 20
          ? `Build an eval set from approvals (Add to eval set): ${f.labeledItems} of at least 20 labeled. Then calibrate thresholds and turn on auto-approval.`
          : "Run calib, pick thresholds, Freeze, then activate auto-approval for the categories it's safe for.",
      href: "/evals",
    },
  ];
}

export const onboardingRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), requireRole("admin"))
    .get("/", async (c) => {
      const facts = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        onboardingFacts(tx, deps.db, deps.now()),
      );
      const body: OnboardingResponse = { dismissed: facts.dismissed, steps: steps(facts) };
      return c.json(body, 200);
    })
    .post("/dismiss", async (c) => {
      await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => dismissOnboarding(tx, deps.now()));
      return c.json({ dismissed: true }, 200);
    });
