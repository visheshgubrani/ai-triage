import { SetupView } from "./setup-view";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Set up AI Triage</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Create the first workspace and its admin. You'll continue at an invitation link, where you choose how to sign
        in. This page works once; add more workspaces later with <code>./triage cli tenant-create</code> (or{" "}
        <code>pnpm tenant:create</code> in a checkout).
      </p>
      <SetupView />
    </main>
  );
}
