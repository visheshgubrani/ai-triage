import Link from "next/link";
import { DocumentsView } from "./documents-view";

export default function DocumentsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <p className="text-sm">
        <Link href="/" className="text-neutral-500 underline-offset-2 hover:underline">
          AI Triage
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Documents</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Everything ingested by email, upload or API, and where the pipeline sent it. Refreshes every 5 seconds.
      </p>
      <DocumentsView />
    </main>
  );
}
