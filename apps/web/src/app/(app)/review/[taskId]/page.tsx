import { Page } from "@/components/page-header";
import { getMe } from "@/lib/session";
import { parseQueue } from "../queue-query";
import { ReviewView } from "./review-view";

export const dynamic = "force-dynamic";

export default async function ReviewTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { taskId } = await params;
  const queue = parseQueue(await searchParams);
  const me = await getMe();
  return <Page wide>{me && <ReviewView taskId={taskId} canReview={me.role !== "viewer"} queue={queue} />}</Page>;
}
