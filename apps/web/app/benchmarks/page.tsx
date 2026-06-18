import { Dashboard } from "./components/dashboard";
import { getPerformanceRuns } from "@/app/lib/benchmarks/server";

export const revalidate = 300;

/**
 * Homepage — server component shell.
 * The interactive dashboard (tabs, charts, data fetching) is a client component.
 */
export default async function HomePage() {
  const runs = await getPerformanceRuns();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Performance Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Benchmarks run on every merge to main. Comparing Next.js (Turbopack) vs vinext (Vite 8).
        </p>
      </div>
      <Dashboard runs={runs} />
    </div>
  );
}
