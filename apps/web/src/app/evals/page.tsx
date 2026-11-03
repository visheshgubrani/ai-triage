import { getMe } from "@/components/header";
import { RunsView } from "./runs-view";
import { EvalsPage } from "./ui";

export const dynamic = "force-dynamic";

export default async function EvalsRunsPage() {
  const me = await getMe();
  return (
    <EvalsPage
      active="/evals"
      intro="Run a config over a labeled split. Iterate on dev; pick thresholds on calib and Freeze; only frozen configs run on test, and those are the headline numbers. Every rate shows its n and 95% Wilson lower bound."
    >
      {me ? (
        <RunsView isAdmin={me.role === "admin"} />
      ) : (
        <p className="mt-6 text-sm text-red-600">Sign in to see evals.</p>
      )}
    </EvalsPage>
  );
}
