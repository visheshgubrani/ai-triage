import { getMe } from "@/lib/session";
import { EvalsPage } from "../ui";
import { ProductionView } from "./production-view";

export const dynamic = "force-dynamic";

export default async function EvalProductionPage() {
  const me = await getMe();
  return (
    <EvalsPage
      active="/evals/production"
      intro="What the live pipeline did: cost, latency, how much went to people, and how often audited auto-approvals were right. Audits are a random sample of auto-approvals, so their precision is an unbiased production estimate."
    >
      {me ? <ProductionView /> : <p className="mt-6 text-sm text-danger">Sign in.</p>}
    </EvalsPage>
  );
}
