/**
 * /compatibility — shows the vinext ↔ Next.js compatibility picture.
 *
 * Top: a GitHub contribution-graph-style grid of test files for the most
 * recent run. Color encodes raw result and support classification.
 *
 * Below: supported-surface and overall pass rates over time.
 *
 * Data is read from the `DB` D1 binding via Drizzle. Results are filtered by
 * `kind` (defaults to "deploy"; future suites can be selected via ?kind=...).
 */
import type { Metadata } from "next";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/app/lib/db/client";
import {
  compatRuns,
  compatFileResults,
  compatSuiteMeta,
  type RouterKind,
} from "@/app/lib/db/schema";
import { CompatibilityViews } from "./compatibility-views";
import type { GridCell } from "./contribution-grid";
import type { TrendPoint } from "./compatibility-line-chart";
import { bucketByRouter, bucketPassRate, bucketSupportedPassRate } from "./router-buckets";
import { getSuiteSupport, NON_SUPPORTED_SUITES } from "./suite-support";

// ISR: rebuild this page at most every 5 minutes. Compat data only changes
// when a nightly deploy-suite run lands, so 5 minutes of staleness is fine
// and keeps the page snappy without re-querying D1 on every request.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Compatibility",
  description:
    "How much of the Next.js test suite passes on vinext today — per-file results and pass-rate trend over time.",
};

/**
 * The `kind` discriminator on stored runs. The schema is designed to support
 * multiple kinds in the future (e.g. ecosystem, vitest), but for now the
 * page hardcodes "deploy". When a second kind is added, prefer a dedicated
 * route over a query param so the URL is explicit and ISR caching keys cleanly.
 */
const KIND = "deploy" as const;

const CARD =
  "flex w-full flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6";

// Pinned-locale date formatter so the dashboard renders identically regardless
// of where (server / which browser) it's drawn. Matches the formatter used by
// the line-chart client component.
const FULL_DATETIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

async function loadData(kind: string): Promise<{
  latestRun: typeof compatRuns.$inferSelect | null;
  latestFiles: GridCell[];
  trend: TrendPoint[];
  error: string | null;
}> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (e) {
    return {
      latestRun: null,
      latestFiles: [],
      trend: [],
      error: `D1 binding not available: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    return { ...(await runQueries(db, kind)), error: null };
  } catch (e) {
    return {
      latestRun: null,
      latestFiles: [],
      trend: [],
      error: `Failed to load compatibility data: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runQueries(
  db: ReturnType<typeof getDb>,
  kind: string,
): Promise<{
  latestRun: typeof compatRuns.$inferSelect | null;
  latestFiles: GridCell[];
  trend: TrendPoint[];
}> {
  // The "latest run" and "last 90 runs trend" queries are independent —
  // issue them in parallel to save one D1 round-trip on every page load.
  // The file-results query depends on the latest run id, so that stays
  // sequential.
  //
  // Trend query: aggregates per-run, per-router totals via JOIN against
  // compat_suite_meta. SUM(CASE WHEN ...) gives us one row per run with
  // app/pages/both/unknown rollups in a single round-trip. SQLite is fine
  // with this shape at our scale (~90 runs × ~1000 file rows = 90k row
  // scan over an indexed JOIN). The "all" series sums every file row and
  // matches compat_runs.{passed,failed,...} — we derive it from the JOIN
  // anyway so all five series stay consistent with each other.
  type TrendRow = {
    created_at: number;
    all_total: number;
    all_passed: number;
    all_failed: number;
    all_skipped: number;
    all_supported_passed: number;
    all_supported_failed: number;
    app_total: number;
    app_passed: number;
    app_failed: number;
    app_skipped: number;
    app_supported_passed: number;
    app_supported_failed: number;
    pages_total: number;
    pages_passed: number;
    pages_failed: number;
    pages_skipped: number;
    pages_supported_passed: number;
    pages_supported_failed: number;
    both_total: number;
    both_passed: number;
    both_failed: number;
    both_skipped: number;
    both_supported_passed: number;
    both_supported_failed: number;
    unknown_total: number;
    unknown_passed: number;
    unknown_failed: number;
    unknown_skipped: number;
    unknown_supported_passed: number;
    unknown_supported_failed: number;
  };

  // The support policy is intentionally joined at read time. Historical
  // compat_file_results rows therefore need no migration or backfill: changing
  // a suite's policy immediately reclassifies every recorded run. Only
  // non-supported suites need rows because supported is the default.
  const outOfScopeValues = sql.join(
    NON_SUPPORTED_SUITES.map((suite) => sql`(${suite})`),
    sql.raw(", "),
  );

  const [latestRows, trendRowsDesc] = await Promise.all([
    db
      .select()
      .from(compatRuns)
      .where(eq(compatRuns.kind, kind))
      .orderBy(desc(compatRuns.createdAt))
      .limit(1),
    // drizzle's `.all()` over a raw SQL fragment returns `unknown[]` by
    // default — we cast through TrendRow because the column list is
    // fixed and audited here.
    //
    // Note: we select `r.created_at` alongside SUM() aggregates while
    // grouping only by `r.id`. SQLite permits this and returns the
    // correct value because `r.created_at` is functionally dependent
    // on the PK — every row in a group shares the same `r.id`, so it
    // shares the same `r.created_at`. Standard SQL (e.g. PostgreSQL
    // with default settings) rejects this; if the query is ever ported,
    // add `r.created_at` to the GROUP BY or wrap it in `MIN()`/`MAX()`.
    db.all(sql`
      WITH out_of_scope(suite) AS (VALUES ${outOfScopeValues})
      SELECT
        r.created_at AS created_at,
        SUM(f.total)   AS all_total,
        SUM(f.passed)  AS all_passed,
        SUM(f.failed)  AS all_failed,
        SUM(f.skipped) AS all_skipped,
        SUM(CASE WHEN o.suite IS NULL THEN f.passed ELSE 0 END) AS all_supported_passed,
        SUM(CASE WHEN o.suite IS NULL THEN f.failed ELSE 0 END) AS all_supported_failed,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.total   ELSE 0 END) AS app_total,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.passed  ELSE 0 END) AS app_passed,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.failed  ELSE 0 END) AS app_failed,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.skipped ELSE 0 END) AS app_skipped,
        SUM(CASE WHEN m.router IN ('app','both') AND o.suite IS NULL THEN f.passed ELSE 0 END) AS app_supported_passed,
        SUM(CASE WHEN m.router IN ('app','both') AND o.suite IS NULL THEN f.failed ELSE 0 END) AS app_supported_failed,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.total   ELSE 0 END) AS pages_total,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.passed  ELSE 0 END) AS pages_passed,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.failed  ELSE 0 END) AS pages_failed,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.skipped ELSE 0 END) AS pages_skipped,
        SUM(CASE WHEN m.router IN ('pages','both') AND o.suite IS NULL THEN f.passed ELSE 0 END) AS pages_supported_passed,
        SUM(CASE WHEN m.router IN ('pages','both') AND o.suite IS NULL THEN f.failed ELSE 0 END) AS pages_supported_failed,
        SUM(CASE WHEN m.router = 'both' THEN f.total   ELSE 0 END) AS both_total,
        SUM(CASE WHEN m.router = 'both' THEN f.passed  ELSE 0 END) AS both_passed,
        SUM(CASE WHEN m.router = 'both' THEN f.failed  ELSE 0 END) AS both_failed,
        SUM(CASE WHEN m.router = 'both' THEN f.skipped ELSE 0 END) AS both_skipped,
        SUM(CASE WHEN m.router = 'both' AND o.suite IS NULL THEN f.passed ELSE 0 END) AS both_supported_passed,
        SUM(CASE WHEN m.router = 'both' AND o.suite IS NULL THEN f.failed ELSE 0 END) AS both_supported_failed,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.total   ELSE 0 END) AS unknown_total,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.passed  ELSE 0 END) AS unknown_passed,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.failed  ELSE 0 END) AS unknown_failed,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.skipped ELSE 0 END) AS unknown_skipped,
        SUM(CASE WHEN (m.router IS NULL OR m.router = 'unknown') AND o.suite IS NULL THEN f.passed ELSE 0 END) AS unknown_supported_passed,
        SUM(CASE WHEN (m.router IS NULL OR m.router = 'unknown') AND o.suite IS NULL THEN f.failed ELSE 0 END) AS unknown_supported_failed
      FROM compat_runs r
      JOIN compat_file_results f ON f.run_id = r.id
      LEFT JOIN compat_suite_meta m ON m.suite = f.suite
      LEFT JOIN out_of_scope o ON o.suite = f.suite
      WHERE r.kind = ${kind}
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 90
    `) as unknown as Promise<TrendRow[]>,
  ]);

  const latestRun = latestRows[0] ?? null;

  // Result rows JOIN-ed against the suite-meta classification table.
  // Suites without a meta row (test added between classifier runs, or
  // classifier hasn't run yet on a fresh DB) render as "unknown". The
  // LEFT JOIN keeps this query a single round-trip to D1.
  const latestFiles: GridCell[] = latestRun
    ? (
        await db
          .select({
            suite: compatFileResults.suite,
            status: compatFileResults.status,
            router: compatSuiteMeta.router,
            total: compatFileResults.total,
            passed: compatFileResults.passed,
            failed: compatFileResults.failed,
            skipped: compatFileResults.skipped,
          })
          .from(compatFileResults)
          .leftJoin(compatSuiteMeta, eq(compatFileResults.suite, compatSuiteMeta.suite))
          .where(and(eq(compatFileResults.kind, kind), eq(compatFileResults.runId, latestRun.id)))
          .orderBy(compatFileResults.suite)
      ).map((r) => {
        const support = getSuiteSupport(r.suite);
        return {
          suite: r.suite,
          status: r.status,
          router: (r.router ?? "unknown") as RouterKind,
          supportStatus: support.status,
          feature: support.feature,
          reason: support.reason,
          total: r.total,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
        };
      })
    : [];

  // Convert the raw per-router columns into the chart's TrendPoint shape.
  // Reverse so the plot reads left=oldest → right=newest. The "all" series
  // here equals the sum of the four router slices (parity / "both" is
  // counted in both app and pages, so "all" is NOT app+pages+both+unknown
  // — it's the unique-suite total). The chart picks one series at a time.
  const trend: TrendPoint[] = trendRowsDesc
    .slice()
    .reverse()
    .map((r) => ({
      createdAt: r.created_at,
      byRouter: {
        all: {
          total: r.all_total,
          passed: r.all_passed,
          failed: r.all_failed,
          skipped: r.all_skipped,
          supportedPassed: r.all_supported_passed,
          supportedFailed: r.all_supported_failed,
        },
        app: {
          total: r.app_total,
          passed: r.app_passed,
          failed: r.app_failed,
          skipped: r.app_skipped,
          supportedPassed: r.app_supported_passed,
          supportedFailed: r.app_supported_failed,
        },
        pages: {
          total: r.pages_total,
          passed: r.pages_passed,
          failed: r.pages_failed,
          skipped: r.pages_skipped,
          supportedPassed: r.pages_supported_passed,
          supportedFailed: r.pages_supported_failed,
        },
        both: {
          total: r.both_total,
          passed: r.both_passed,
          failed: r.both_failed,
          skipped: r.both_skipped,
          supportedPassed: r.both_supported_passed,
          supportedFailed: r.both_supported_failed,
        },
        unknown: {
          total: r.unknown_total,
          passed: r.unknown_passed,
          failed: r.unknown_failed,
          skipped: r.unknown_skipped,
          supportedPassed: r.unknown_supported_passed,
          supportedFailed: r.unknown_supported_failed,
        },
      },
    }));

  return { latestRun, latestFiles, trend };
}

export default async function CompatibilityPage() {
  const { latestRun, latestFiles, trend, error } = await loadData(KIND);
  const byRouter = bucketByRouter(latestFiles);
  const supportedPassRate = bucketSupportedPassRate(byRouter.all);
  const overallPassRate = bucketPassRate(byRouter.all);
  const verdicts = byRouter.all.passed + byRouter.all.failed;
  const supportedVerdicts = byRouter.all.supportedPassed + byRouter.all.supportedFailed;
  const supportedCoverage = verdicts > 0 ? (supportedVerdicts / verdicts) * 100 : 0;
  const supportedFailingFiles = latestFiles.filter(
    (file) => file.supportStatus === "supported" && file.failed > 0,
  ).length;

  return (
    <>
      <section className="mx-auto w-full max-w-6xl px-6 pt-24 pb-10">
        <div className="mb-3 font-mono text-[11px] tracking-[0.16em] text-[var(--orange-soft)] uppercase">
          Deploy-suite parity
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-[var(--ink)] sm:text-5xl">
          Next.js compatibility
        </h1>
        <p className="mt-4 max-w-2xl text-[var(--ink-sub)]">
          Results from the Next.js deploy test suite, run against vinext. Each dot below is one test
          file. Hover or select a dot for details; selecting keeps them open and lets you copy them.
          The line chart tracks supported and overall pass rates across runs.
        </p>
        {latestRun ? (
          <p className="mt-3 text-sm text-[var(--sub)]">
            Latest run:{" "}
            <span className="text-[var(--ink)]">
              {FULL_DATETIME.format(new Date(latestRun.createdAt))}
            </span>
            {latestRun.nextRef ? (
              <>
                {" · "}Next.js{" "}
                <code className="font-mono text-[var(--ink)]">{latestRun.nextRef}</code>
              </>
            ) : null}
            {latestRun.vinextRef ? (
              <>
                {" · "}vinext{" "}
                <code className="font-mono text-[var(--ink)]">{latestRun.vinextRef}</code>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {error ? (
        <section className="mx-auto w-full max-w-6xl px-6 pb-6">
          <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 text-sm text-[var(--ink)]">
            <strong>Compatibility data unavailable.</strong> {error}
          </div>
        </section>
      ) : null}

      <section className="mx-auto w-full max-w-6xl px-6 pb-10">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {supportedPassRate.toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">Supported pass rate</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {overallPassRate.toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">Overall pass rate</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {supportedCoverage.toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">Supported surface coverage</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {supportedFailingFiles}
            </div>
            <div className="text-sm text-[var(--sub)]">Supported files with failures</div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-10">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">By router</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {bucketSupportedPassRate(byRouter.app).toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">
              App Router supported · {bucketPassRate(byRouter.app).toFixed(1)}% overall
            </div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {bucketSupportedPassRate(byRouter.pages).toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">
              Pages Router supported · {bucketPassRate(byRouter.pages).toFixed(1)}% overall
            </div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {bucketSupportedPassRate(byRouter.both).toFixed(1)}%
            </div>
            <div className="text-sm text-[var(--sub)]">
              Mixed supported · {bucketPassRate(byRouter.both).toFixed(1)}% overall
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-20">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Test files and trend</h2>
          <span className="text-sm text-[var(--sub)]">
            {latestFiles.length} files in the latest run · last {trend.length} run
            {trend.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className={CARD}>
          <CompatibilityViews cells={latestFiles} trend={trend} />
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="flex flex-col items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6">
          <h3 className="text-base font-semibold">How this works</h3>
          <p className="text-sm leading-relaxed text-[var(--ink-sub)]">
            The Next.js deploy test suite runs nightly against vinext. The GitHub Actions workflow
            aggregates each test file&apos;s pass / fail / skip counts and POSTs the results to this
            app&apos;s ingest endpoint, where they are stored in a D1 database. Each suite is
            classified by which router(s) its fixture exercises (App Router, Pages Router, or both —
            &quot;mixed&quot;). Mixed suites are counted toward both router pass rates, so adding
            the App and Pages numbers exceeds the total. Suites without an on-disk fixture (config /
            build / edge-runtime tests) are bucketed under &quot;Other&quot;. Results are keyed by{" "}
            <code>kind</code> so additional suites (e.g. ecosystem apps, Vitest) can be added later
            without schema changes.
          </p>
          <p className="text-sm leading-relaxed text-[var(--ink-sub)]">
            The supported pass rate excludes suites classified as deferred, specific to the Next.js
            compiler, or awaiting equivalent Vite coverage. The overall pass rate retains their raw
            results. Both rates exclude tests skipped by Next.js itself. Support classifications are
            joined when this page is read, so they apply consistently to historical runs without
            rewriting stored results.
          </p>
          <p className="text-sm leading-relaxed text-[var(--ink-sub)]">
            Router and support classifications are both applied at read time. Reclassifying a suite
            therefore updates its supported rate, color, and router bucket across every historical
            run while leaving the stored raw results and overall rate unchanged.
          </p>
          <a
            href="https://github.com/cloudflare/vinext/actions/workflows/nextjs-deploy-suite.yml"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link inline-flex items-center gap-2 border-b border-transparent font-mono text-xs text-[var(--orange-soft)] no-underline"
          >
            View deploy suite runs
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        </div>
      </section>
    </>
  );
}
