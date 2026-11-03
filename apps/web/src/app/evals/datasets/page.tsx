import { getMe } from "@/components/header";
import { EvalsPage } from "../ui";
import { DatasetsView } from "./datasets-view";

export const dynamic = "force-dynamic";

export default async function EvalDatasetsPage() {
  const me = await getMe();
  return (
    <EvalsPage
      active="/evals/datasets"
      intro="Labeled examples, each with a frozen copy of its source. Items come from the seeded fixtures, from `pnpm eval:import`, or from reviews (Add to eval set). A wrong label is retired, never edited."
    >
      {me ? <DatasetsView isAdmin={me.role === "admin"} /> : <p className="mt-6 text-sm text-red-600">Sign in.</p>}
    </EvalsPage>
  );
}
