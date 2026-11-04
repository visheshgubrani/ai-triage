import { Page } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { InboxView } from "./inbox-view";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const me = await getMe();
  return <Page>{me && <InboxView canReview={me.role !== "viewer"} isAdmin={me.role === "admin"} />}</Page>;
}
