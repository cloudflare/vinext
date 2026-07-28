import type { Metadata } from "next";
import { Dashboard } from "./components/dashboard";
import { getPerformanceRuns } from "@/app/lib/benchmarks/server";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Live performance benchmarks comparing Next.js (Turbopack) and vinext (Vite), run on every merge to main.",
};

/**
 * Homepage — server component shell.
 * The interactive dashboard (tabs, charts, data fetching) is a client component.
 */
export default async function HomePage() {
  const runs = await getPerformanceRuns();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-24 pb-10">
      <div className="mb-8">
        <div className="mb-3 font-mono text-[11px] tracking-[0.16em] text-[var(--orange-soft)] uppercase">
          Live performance
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Performance Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--sub)]">
          Benchmarks run on every merge to main. Comparing Next.js (Turbopack) vs vinext (Vite 8).
        </p>
      </div>
      <Dashboard runs={runs} />
    </div>
  );
}
