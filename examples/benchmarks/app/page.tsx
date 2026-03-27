import { Dashboard } from "./components/dashboard";

/**
 * Homepage — server component shell.
 * The interactive dashboard (tabs, charts, data fetching) is a client component.
 */
export default function HomePage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Performance Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Benchmarks run on every merge to main. Comparing Next.js (Turbopack) vs vinext (Vite
          8).
        </p>
      </div>
      <Dashboard />
    </div>
  );
}
