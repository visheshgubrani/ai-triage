import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        There's nothing at this address, or it belongs to another workspace.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/" className="underline underline-offset-2">
          Home
        </Link>
      </p>
    </main>
  );
}
