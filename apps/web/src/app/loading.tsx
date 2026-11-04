import { LoadingBlock } from "@/components/loading";

export default function Loading() {
  return (
    <main className="mx-auto max-w-md p-8">
      <LoadingBlock rows={4} />
    </main>
  );
}
