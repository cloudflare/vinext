import { desc, eq } from "drizzle-orm";
import { getDb } from "@/app/lib/db/client";
import { compatRuns } from "@/app/lib/db/schema";
import { getPerformanceRuns } from "@/app/lib/benchmarks/server";

/**
 * Headline numbers for the landing page, sourced from the same D1 data that
 * backs /compatibility and /benchmarks so the marketing claims track reality.
 *
 * Every field carries a static fallback (the last hand-verified numbers) so
 * the page still renders in dev without a D1 binding or before the first
 * ingest. Provenance keeps those reference values distinct from live results.
 */
export type LandingStats = {
  /** Latest deploy-suite pass rate, integer percent. */
  compatPassRate: number;
  /** Clean production build, seconds (median of latest main run). */
  buildSeconds: { vinext: number; nextjs: number };
  /** Gzipped client bundle, bytes (median of latest main run). */
  bundleBytes: { vinext: number; nextjs: number };
  provenance: {
    compatibility: MetricProvenance;
    benchmark: MetricProvenance;
  };
};

type MetricProvenance =
  | { source: "live"; measuredAt: string; commitSha: string | null }
  | { source: "fallback" };

const FALLBACK: LandingStats = {
  compatPassRate: 92,
  buildSeconds: { vinext: 3.1, nextjs: 6.2 },
  bundleBytes: { vinext: 125 * 1024, nextjs: 185 * 1024 },
  provenance: {
    compatibility: { source: "fallback" },
    benchmark: { source: "fallback" },
  },
};

type CompatSnapshot = {
  passRate: number;
  measuredAt: string;
  commitSha: string | null;
};

type BenchmarkRun = {
  commitSha: string;
  measuredAt: string;
  measurements: Array<{ scenarioId: string; implementationId: string; median: number }>;
};

async function loadCompatPassRate(): Promise<CompatSnapshot | null> {
  const db = getDb();
  const [latest] = await db
    .select({
      total: compatRuns.total,
      passed: compatRuns.passed,
      createdAt: compatRuns.createdAt,
      commitSha: compatRuns.commitSha,
    })
    .from(compatRuns)
    .where(eq(compatRuns.kind, "deploy"))
    .orderBy(desc(compatRuns.createdAt))
    .limit(1);
  if (!latest || latest.total <= 0) return null;
  return {
    passRate: Math.round((latest.passed / latest.total) * 100),
    measuredAt: new Date(latest.createdAt).toISOString(),
    commitSha: latest.commitSha,
  };
}

function implementationPair(
  measurements: BenchmarkRun["measurements"],
  scenarioId: string,
): { vinext: number; nextjs: number } | null {
  const median = (implementationId: string) =>
    measurements.find((m) => m.scenarioId === scenarioId && m.implementationId === implementationId)
      ?.median;
  const vinext = median("vinext");
  const nextjs = median("nextjs");
  if (vinext === undefined || nextjs === undefined || vinext <= 0 || nextjs <= 0) return null;
  return { vinext, nextjs };
}

export function resolveLandingStats(
  compat: PromiseSettledResult<CompatSnapshot | null>,
  perf: PromiseSettledResult<BenchmarkRun[]>,
): LandingStats {
  const stats: LandingStats = {
    ...FALLBACK,
    provenance: { ...FALLBACK.provenance },
  };

  if (compat.status === "fulfilled" && compat.value) {
    stats.compatPassRate = compat.value.passRate;
    stats.provenance.compatibility = {
      source: "live",
      measuredAt: compat.value.measuredAt,
      commitSha: compat.value.commitSha,
    };
  }

  if (perf.status === "fulfilled" && perf.value.length > 0) {
    const run = perf.value[0];
    const measurements = run.measurements;
    const build = implementationPair(measurements, "production-build");
    const bundle = implementationPair(measurements, "client-bundle-gzip");
    if (build && bundle) {
      stats.buildSeconds = { vinext: build.vinext / 1000, nextjs: build.nextjs / 1000 };
      stats.bundleBytes = bundle;
      stats.provenance.benchmark = {
        source: "live",
        measuredAt: run.measuredAt,
        commitSha: run.commitSha,
      };
    }
  }

  return stats;
}

export async function getLandingStats(): Promise<LandingStats> {
  const [compat, perf] = await Promise.allSettled([loadCompatPassRate(), getPerformanceRuns(1)]);
  return resolveLandingStats(compat, perf);
}

/** "2×" for 2.04, "1.8×" for 1.83 — near-integer multiples read cleaner rounded. */
function formatMultiple(ratio: number): string {
  const rounded = Math.round(ratio * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}×` : `${rounded.toFixed(1)}×`;
}

export function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Comparative framing for a vinext-vs-Next.js pair, derived once so copy can
 * never disagree with the measured ordering. The numbers are live: a
 * regression must read "1.2× slower", not "0.8× faster".
 */
type Verdict = "better" | "worse" | "par";

export type BuildComparison = {
  verdict: Verdict;
  /** Winner-relative multiple, always ≥ 1 (e.g. "2×"). "1×" on "par". */
  multiple: string;
};

export function compareBuild(seconds: LandingStats["buildSeconds"]): BuildComparison {
  const ratio = Math.max(seconds.vinext, seconds.nextjs) / Math.min(seconds.vinext, seconds.nextjs);
  // Decide on the displayed ratio so a near-tie never renders "1× faster".
  if (Math.round(ratio * 10) / 10 === 1) return { verdict: "par", multiple: "1×" };
  return {
    verdict: seconds.vinext < seconds.nextjs ? "better" : "worse",
    multiple: formatMultiple(ratio),
  };
}

export type BundleComparison = {
  verdict: Verdict;
  /** Absolute size difference as integer percent of the Next.js bundle. */
  pct: number;
};

export function compareBundle(bytes: LandingStats["bundleBytes"]): BundleComparison {
  const pct = Math.round((1 - bytes.vinext / bytes.nextjs) * 100);
  if (pct === 0) return { verdict: "par", pct: 0 };
  return pct > 0 ? { verdict: "better", pct } : { verdict: "worse", pct: -pct };
}
