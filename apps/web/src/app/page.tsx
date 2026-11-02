import { HealthResponse } from "@ai-triage/contracts";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getHealth(): Promise<HealthResponse | null> {
  try {
    const res = await api.health.$get();
    return HealthResponse.parse(await res.json());
  } catch {
    return null;
  }
}

const sections = [
  { name: "Inbox", detail: "Incoming documents and their routing decisions" },
  { name: "Review queue", detail: "Low-confidence items awaiting a human" },
  { name: "Evals", detail: "Accuracy per category, cost and latency per request" },
];

export default async function Home() {
  const health = await getHealth();
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">AI Triage</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        Scaffold is running. Pipeline, review queue and evals are not built yet.
      </p>

      <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-500">API health</h2>
        {health ? (
          <p className="mt-1 font-mono text-sm">
            status: {health.status} · db: {health.db}
          </p>
        ) : (
          <p className="mt-1 font-mono text-sm text-red-600">API unreachable</p>
        )}
      </section>

      <ul className="mt-8 grid gap-3 sm:grid-cols-3">
        {sections.map((s) => (
          <li key={s.name} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-medium">{s.name}</p>
            <p className="mt-1 text-sm text-neutral-500">{s.detail}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
