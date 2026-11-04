import { Page } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** The shape of a page while its server part renders. */
export default function Loading() {
  return (
    <Page>
      <div aria-busy="true">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <Skeleton className="mt-4 h-72 rounded-xl" />
      </div>
    </Page>
  );
}
