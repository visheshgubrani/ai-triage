import { Page, PageHeader } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { DocumentsView } from "./documents-view";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const me = await getMe();
  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Everything ingested by email, upload or API, and where the pipeline sent it."
      />
      <DocumentsView canUpload={me !== null && me.role !== "viewer"} />
    </Page>
  );
}
