import { SearchX } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

export default function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <EmptyState
        heading
        icon={SearchX}
        title="Not found"
        description="There's nothing at this address, or it belongs to another workspace."
        action={
          <Button asChild variant="primary">
            <Link href="/">Home</Link>
          </Button>
        }
      />
    </main>
  );
}
