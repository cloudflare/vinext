/**
 * /compatibility — shows the vinext ↔ Next.js compatibility picture.
 *
 * Top: a GitHub contribution-graph-style grid of test files for the most
 * recent run. Color encodes per-file status (green / orange / red / gray).
 *
 * Below: a line chart of overall pass-rate over time, one point per run.
 *
 * Data is read from the `DB` D1 binding via Drizzle. Results are filtered by
 * `kind` (defaults to "deploy"; future suites can be selected via ?kind=...).
 */
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
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
import { bucketByRouter, bucketPassRate } from "./router-buckets";

// ISR: rebuild this page at most every 5 minutes. Compat data only changes
// when a nightly deploy-suite run lands, so 5 minutes of staleness is fine
// and keeps the page snappy without re-querying D1 on every request.
export const revalidate = 300;

/**
 * The `kind` discriminator on stored runs. The schema is designed to support
 * multiple kinds in the future (e.g. ecosystem, vitest), but for now the
 * page hardcodes "deploy". When a second kind is added, prefer a dedicated
 * route over a query param so the URL is explicit and ISR caching keys cleanly.
 */
const KIND = "deploy" as const;

const CARD = "flex w-full flex-col gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-hairline";

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
    app_total: number;
    app_passed: number;
    app_failed: number;
    app_skipped: number;
    pages_total: number;
    pages_passed: number;
    pages_failed: number;
    pages_skipped: number;
    both_total: number;
    both_passed: number;
    both_failed: number;
    both_skipped: number;
    unknown_total: number;
    unknown_passed: number;
    unknown_failed: number;
    unknown_skipped: number;
  };

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
      SELECT
        r.created_at AS created_at,
        SUM(f.total)   AS all_total,
        SUM(f.passed)  AS all_passed,
        SUM(f.failed)  AS all_failed,
        SUM(f.skipped) AS all_skipped,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.total   ELSE 0 END) AS app_total,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.passed  ELSE 0 END) AS app_passed,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.failed  ELSE 0 END) AS app_failed,
        SUM(CASE WHEN m.router IN ('app','both') THEN f.skipped ELSE 0 END) AS app_skipped,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.total   ELSE 0 END) AS pages_total,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.passed  ELSE 0 END) AS pages_passed,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.failed  ELSE 0 END) AS pages_failed,
        SUM(CASE WHEN m.router IN ('pages','both') THEN f.skipped ELSE 0 END) AS pages_skipped,
        SUM(CASE WHEN m.router = 'both' THEN f.total   ELSE 0 END) AS both_total,
        SUM(CASE WHEN m.router = 'both' THEN f.passed  ELSE 0 END) AS both_passed,
        SUM(CASE WHEN m.router = 'both' THEN f.failed  ELSE 0 END) AS both_failed,
        SUM(CASE WHEN m.router = 'both' THEN f.skipped ELSE 0 END) AS both_skipped,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.total   ELSE 0 END) AS unknown_total,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.passed  ELSE 0 END) AS unknown_passed,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.failed  ELSE 0 END) AS unknown_failed,
        SUM(CASE WHEN m.router IS NULL OR m.router = 'unknown' THEN f.skipped ELSE 0 END) AS unknown_skipped
      FROM compat_runs r
      JOIN compat_file_results f ON f.run_id = r.id
      LEFT JOIN compat_suite_meta m ON m.suite = f.suite
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
      ).map((r) => ({
        suite: r.suite,
        status: r.status,
        router: (r.router ?? "unknown") as RouterKind,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      }))
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
        },
        app: {
          total: r.app_total,
          passed: r.app_passed,
          failed: r.app_failed,
          skipped: r.app_skipped,
        },
        pages: {
          total: r.pages_total,
          passed: r.pages_passed,
          failed: r.pages_failed,
          skipped: r.pages_skipped,
        },
        both: {
          total: r.both_total,
          passed: r.both_passed,
          failed: r.both_failed,
          skipped: r.both_skipped,
        },
        unknown: {
          total: r.unknown_total,
          passed: r.unknown_passed,
          failed: r.unknown_failed,
          skipped: r.unknown_skipped,
        },
      },
    }));

  return { latestRun, latestFiles, trend };
}

export default async function CompatibilityPage() {
  const { latestRun, latestFiles, trend, error } = await loadData(KIND);

  const fileCounts = latestFiles.reduce(
    (acc, f) => {
      acc[f.status]++;
      return acc;
    },
    { pass: 0, partial: 0, fail: 0, skip: 0 },
  );

  const byRouter = bucketByRouter(latestFiles);

  // Skipped tests don't count against the pass rate; denominator is the
  // tests that actually ran (passed + failed).
  const passRate = (() => {
    if (!latestRun) return 0;
    const denom = latestRun.passed + latestRun.failed;
    return denom > 0 ? (latestRun.passed / denom) * 100 : 0;
  })();

  return (
    <>
      <section className="mx-auto w-full max-w-6xl px-6 pt-16 pb-10">
        <h1 className="text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
          Next.js compatibility
        </h1>
        <p className="mt-4 max-w-2xl text-kumo-subtle">
          Results from the Next.js deploy test suite, run against vinext. Each dot below is one test
          file. Hover for details. The line chart tracks overall pass rate across runs.
        </p>
        {latestRun ? (
          <p className="mt-3 text-sm text-kumo-subtle">
            Latest run:{" "}
            <span className="text-kumo-default">
              {FULL_DATETIME.format(new Date(latestRun.createdAt))}
            </span>
            {latestRun.nextRef ? (
              <>
                {" · "}Next.js{" "}
                <code className="font-mono text-kumo-default">{latestRun.nextRef}</code>
              </>
            ) : null}
            {latestRun.vinextRef ? (
              <>
                {" · "}vinext{" "}
                <code className="font-mono text-kumo-default">{latestRun.vinextRef}</code>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {error ? (
        <section className="mx-auto w-full max-w-6xl px-6 pb-6">
          <div className="rounded-lg bg-kumo-base p-4 text-sm text-kumo-default ring ring-kumo-hairline">
            <strong>Compatibility data unavailable.</strong> {error}
          </div>
        </section>
      ) : null}

      <section className="mx-auto w-full max-w-6xl px-6 pb-10">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {passRate.toFixed(1)}%
            </div>
            <div className="text-sm text-kumo-subtle">Pass rate (latest run)</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {latestFiles.length}
            </div>
            <div className="text-sm text-kumo-subtle">Test files</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {fileCounts.pass}
            </div>
            <div className="text-sm text-kumo-subtle">Files fully passing</div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {fileCounts.fail + fileCounts.partial}
            </div>
            <div className="text-sm text-kumo-subtle">Files with failures</div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-10">
        <div className="mb-4">
          <Text variant="heading2" as="h2">
            By router
          </Text>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {bucketPassRate(byRouter.app).toFixed(1)}%
            </div>
            <div className="text-sm text-kumo-subtle">
              App Router pass rate · {byRouter.app.files} files
            </div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {bucketPassRate(byRouter.pages).toFixed(1)}%
            </div>
            <div className="text-sm text-kumo-subtle">
              Pages Router pass rate · {byRouter.pages.files} files
            </div>
          </div>
          <div className={CARD}>
            <div className="text-3xl font-semibold tracking-tight text-kumo-default">
              {bucketPassRate(byRouter.both).toFixed(1)}%
            </div>
            <div className="text-sm text-kumo-subtle">
              Mixed pass rate · {byRouter.both.files} files
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-20">
        <div className="mb-4 flex items-baseline justify-between">
          <Text variant="heading2" as="h2">
            Test files and trend
          </Text>
          <span className="text-sm text-kumo-subtle">
            {latestFiles.length} files in the latest run · last {trend.length} run
            {trend.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className={CARD}>
          <CompatibilityViews cells={latestFiles} trend={trend} />
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="flex flex-col items-start gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-hairline">
          <Text variant="heading3" as="h3">
            How this works
          </Text>
          <p className="text-sm leading-relaxed text-kumo-subtle">
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
          <p className="text-sm leading-relaxed text-kumo-subtle">
            Per-router trend lines use the latest classification snapshot, so reclassifying a suite
            (when the Next.js ref bumps, or when the heuristic improves) updates how it appears
            across every historical run. The aggregate &quot;All&quot; line is unaffected.
          </p>
          <LinkButton
            variant="outline"
            size="sm"
            icon={<ArrowSquareOutIcon />}
            href="https://github.com/cloudflare/vinext/actions/workflows/nextjs-deploy-suite.yml"
            external
          >
            View deploy suite runs
          </LinkButton>
        </div>
      </section>
    </>
  );
}
