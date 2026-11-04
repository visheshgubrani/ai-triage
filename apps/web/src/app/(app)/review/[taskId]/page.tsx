import { Page } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { ReviewView } from "./review-view";

export const dynamic = "force-dynamic";

export default async function ReviewTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const me = await getMe();
  return <Page wide>{me && <ReviewView taskId={taskId} canReview={me.role !== "viewer"} />}</Page>;
}
