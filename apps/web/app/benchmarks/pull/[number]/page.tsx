import Link from "next/link";
import { notFound } from "next/navigation";
import { getPullComparison } from "@/app/lib/benchmarks/server";
import { PerformanceComparison } from "../../components/performance-comparison";

export const revalidate = 300;

export default async function PullComparisonPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  const comparison = await getPullComparison(number);
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
