import type { Metadata } from "next";
import { Dashboard } from "./components/dashboard";
import { getPerformanceRuns } from "@/app/lib/benchmarks/server";
import { StructuredData } from "@/app/_components/structured-data";
import { breadcrumbGraph } from "@/app/_lib/structured-data";

export const revalidate = 300;

// Bare title: the root layout's `%s — vinext` template supplies the suffix.
// openGraph/twitter titles are not templated, so they carry the brand explicitly.
const title = "Performance benchmarks";
const brandedTitle = `${title} — vinext`;
const description =
  "Compare vinext and Next.js production build time, dev server startup, and bundle size.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/benchmarks",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "vinext",
    title: brandedTitle,
    description,
    url: "/benchmarks",
  },
};

/**
 * /benchmarks — server component shell.
 * The interactive dashboard (tabs, charts, data fetching) is a client component.
 */
export default async function BenchmarksPage() {
  const runs = await getPerformanceRuns();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <StructuredData graph={breadcrumbGraph(title, "/benchmarks")} />
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">vinext performance benchmarks</h1>
        <p className="mt-1 text-sm text-gray-500">
          Benchmarks run on every merge to main. Comparing Next.js (Turbopack) vs vinext (Vite 8).
        </p>
      </div>
      <Dashboard runs={runs} />
    </div>
  );
}
