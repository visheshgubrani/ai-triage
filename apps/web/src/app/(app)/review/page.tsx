import { Page } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { InboxView } from "./inbox-view";
import { parseQueue, type QueueEnd } from "./queue-query";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const me = await getMe();
  return (
    <Page>
      {me && (
        <InboxView
          canReview={me.role !== "viewer"}
          isAdmin={me.role === "admin"}
          initial={parseQueue(params)}
          end={params.end === "cleared" || params.end === "skipped" ? (params.end as QueueEnd) : undefined}
        />
      )}
    </Page>
  );
}
