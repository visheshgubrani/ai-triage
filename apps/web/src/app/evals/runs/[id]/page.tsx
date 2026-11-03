import Link from "next/link";
import { getMe } from "@/components/header";
import { RunView } from "./run-view";

export const dynamic = "force-dynamic";

export default async function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <p className="text-sm">
        <Link href="/evals" className="text-neutral-500 underline-offset-2 hover:underline">
          Evals
        </Link>
      </p>
      {me ? (
        <RunView runId={id} isAdmin={me.role === "admin"} />
      ) : (
        <p className="mt-6 text-sm text-red-600">Sign in.</p>
      )}
    </main>
  );
}
