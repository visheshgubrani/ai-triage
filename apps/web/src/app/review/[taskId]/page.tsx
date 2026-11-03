import Link from "next/link";
import { getMe } from "@/components/header";
import { ReviewView } from "./review-view";

export const dynamic = "force-dynamic";

export default async function ReviewTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const me = await getMe();
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <p className="text-sm">
        <Link href="/review" className="text-neutral-500 underline-offset-2 hover:underline">
          Review queue
        </Link>
      </p>
      {me ? (
        <ReviewView taskId={taskId} canReview={me.role !== "viewer"} />
      ) : (
        <p className="mt-6 text-sm text-red-600">Sign in to review.</p>
      )}
    </main>
  );
}
