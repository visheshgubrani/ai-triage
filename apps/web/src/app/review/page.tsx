import { getMe } from "@/components/header";
import { InboxView } from "./inbox-view";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const me = await getMe();
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Documents waiting for a human, oldest first. Claim one to decide it; your claim lasts 10 minutes and renews
        while the page is open. Refreshes every 5 seconds.
      </p>
      {me ? (
        <InboxView canReview={me.role !== "viewer"} isAdmin={me.role === "admin"} />
      ) : (
        <p className="mt-6 text-sm text-red-600">Sign in to see the review queue.</p>
      )}
    </main>
  );
}
