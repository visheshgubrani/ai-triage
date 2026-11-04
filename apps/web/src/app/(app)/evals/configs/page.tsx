import { getMe } from "@/lib/session";
import { EvalsPage } from "../ui";
import { ConfigsView } from "./configs-view";

export const dynamic = "force-dynamic";

export default async function EvalConfigsPage() {
  const me = await getMe();
  return (
    <EvalsPage
      active="/evals/configs"
      intro="Pipeline config versions never change. Derive a candidate to try another model, effort or threshold on dev; freeze it from a calib run; activate a frozen version to run new documents with it."
    >
      {me ? <ConfigsView isAdmin={me.role === "admin"} /> : <p className="mt-6 text-sm text-danger">Sign in.</p>}
    </EvalsPage>
  );
}
