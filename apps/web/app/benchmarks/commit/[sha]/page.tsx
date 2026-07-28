import Link from "next/link";
import { notFound } from "next/navigation";
import { getCommitComparison } from "@/app/lib/benchmarks/server";
import { PerformanceComparison } from "../../components/performance-comparison";

export const revalidate = 300;

export default async function CommitPage({ params }: { params: Promise<{ sha: string }> }) {
  const { sha } = await params;
  const comparison = await getCommitComparison(sha);
  if (!comparison) notFound();
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-24 pb-10">
      <div className="mb-6">
        <Link href="/benchmarks" className="text-sm text-[var(--orange-soft)] hover:underline">
          &larr; Back to dashboard
        </Link>
      </div>
      <PerformanceComparison comparison={comparison} />
    </div>
  );
}
