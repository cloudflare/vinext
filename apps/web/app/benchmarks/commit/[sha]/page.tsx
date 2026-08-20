import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getCommitComparison } from "@/app/lib/benchmarks/server";
import { PerformanceComparison } from "../../components/performance-comparison";
import { createBenchmarkMetadata } from "../../metadata";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sha: string }>;
}): Promise<Metadata> {
  const { sha } = await params;
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return createBenchmarkMetadata({
      title: "Commit performance benchmarks",
      description: "Historical vinext performance measurements by commit.",
      path: "/benchmarks",
      index: false,
    });
  }

  const normalizedSha = sha.toLowerCase();
  const shortSha = normalizedSha.slice(0, 7);
  return createBenchmarkMetadata({
    title: `Commit ${shortSha} performance benchmarks`,
    description: `Build, bundle-size, and development-startup performance measurements for vinext commit ${shortSha}.`,
    path: `/benchmarks/commit/${normalizedSha}`,
    index: false,
  });
}

export default async function CommitPage({ params }: { params: Promise<{ sha: string }> }) {
  const { sha } = await params;
  const comparison = await getCommitComparison(sha);
  if (!comparison) notFound();
  const canonicalSha = comparison.head.sha.toLowerCase();
  if (sha !== canonicalSha) permanentRedirect(`/benchmarks/commit/${canonicalSha}`);
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <Link href="/benchmarks" className="text-sm text-blue-600 hover:underline">
          &larr; Back to dashboard
        </Link>
      </div>
      <PerformanceComparison comparison={comparison} />
    </div>
  );
}
