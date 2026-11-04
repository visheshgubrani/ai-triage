import { Page } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { RunView } from "./run-view";

export const dynamic = "force-dynamic";

export default async function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  return <Page>{me && <RunView runId={id} isAdmin={me.role === "admin"} />}</Page>;
}
