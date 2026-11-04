import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { DiffView } from "./diff-view";

export const dynamic = "force-dynamic";

export default async function EvalDiffPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  const me = await getMe();
  return (
    <Page>
      {me && a && b ? (
        <DiffView a={a} b={b} />
      ) : (
        <>
          <PageHeader back={{ href: "/evals", label: "Evals" }} title="Compare runs" />
          <EmptyState
            title="Pick two runs to compare"
            description="Open a run and choose another under “Compare with”."
          />
        </>
      )}
    </Page>
  );
}
