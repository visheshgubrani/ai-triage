import Link from "next/link";
import { getMe } from "@/components/header";
import { DiffView } from "./diff-view";

export const dynamic = "force-dynamic";

export default async function EvalDiffPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  const me = await getMe();
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <p className="text-sm">
        <Link href="/evals" className="text-neutral-500 underline-offset-2 hover:underline">
          Evals
        </Link>
      </p>
      {me && a && b ? <DiffView a={a} b={b} /> : <p className="mt-6 text-sm text-red-600">Pick two runs to compare.</p>}
    </main>
  );
}
