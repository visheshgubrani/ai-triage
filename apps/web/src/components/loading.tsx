import { Skeleton } from "@/components/ui/skeleton";

/** The first load of a client view: the shape of a list, in place of "Loading…". */
export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="space-y-2.5 py-1">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders
        <Skeleton key={i} className="h-4 w-full last:w-2/3" />
      ))}
    </div>
  );
}
