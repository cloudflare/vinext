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
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/app/lib/db/client";
import { compatRuns, compatFileResults } from "@/app/lib/db/schema";
import { ContributionGrid, type GridCell } from "./contribution-grid";
import { CompatibilityLineChart, type LineSeriesPoint } from "./compatibility-line-chart";

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
  trend: LineSeriesPoint[];
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
  trend: LineSeriesPoint[];
}> {
  // The "latest run" and "last 90 runs trend" queries are independent —
  // issue them in parallel to save one D1 round-trip on every page load.
  // The file-results query depends on the latest run id, so that stays
  // sequential.
  const [latestRows, trendRowsDesc] = await Promise.all([
    db
      .select()
      .from(compatRuns)
      .where(eq(compatRuns.kind, kind))
      .orderBy(desc(compatRuns.createdAt))
      .limit(1),
    // Trend: cap to last 90 runs to keep the page snappy. The result is
    // newest-first; we reverse below to plot oldest → newest.
    db
      .select({
        createdAt: compatRuns.createdAt,
        total: compatRuns.total,
        passed: compatRuns.passed,
        failed: compatRuns.failed,
        skipped: compatRuns.skipped,
      })
      .from(compatRuns)
      .where(eq(compatRuns.kind, kind))
      .orderBy(desc(compatRuns.createdAt))
      .limit(90),
  ]);

  const latestRun = latestRows[0] ?? null;

  const latestFiles: GridCell[] = latestRun
    ? (
        await db
          .select({
            suite: compatFileResults.suite,
            status: compatFileResults.status,
            total: compatFileResults.total,
            passed: compatFileResults.passed,
            failed: compatFileResults.failed,
            skipped: compatFileResults.skipped,
          })
          .from(compatFileResults)
          .where(and(eq(compatFileResults.kind, kind), eq(compatFileResults.runId, latestRun.id)))
          .orderBy(compatFileResults.suite)
      ).map((r) => ({
        suite: r.suite,
        status: r.status,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      }))
    : [];

  // Pass rate excludes skipped tests: skipped → "not relevant", not "failure".
  // Denominator is passed + failed (the tests that actually ran a verdict).
  const trend: LineSeriesPoint[] = trendRowsDesc
    .slice()
    .reverse()
    .map((r) => {
      const denom = r.passed + r.failed;
      return {
        createdAt: r.createdAt,
        passRate: denom > 0 ? r.passed / denom : 0,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      };
    });

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

      <section className="mx-auto w-full max-w-6xl px-6 pb-12">
        <div className="mb-4 flex items-baseline justify-between">
          <Text variant="heading2" as="h2">
            Test files
          </Text>
          <span className="text-sm text-kumo-subtle">
            One dot per file in the latest run · {latestFiles.length} files
          </span>
        </div>
        <div className={CARD}>
          <ContributionGrid cells={latestFiles} />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-20">
        <div className="mb-4 flex items-baseline justify-between">
          <Text variant="heading2" as="h2">
            Compatibility over time
          </Text>
          <span className="text-sm text-kumo-subtle">
            Pass rate across the last {trend.length} run{trend.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className={CARD}>
          <CompatibilityLineChart points={trend} />
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
            app&apos;s ingest endpoint, where they are stored in a D1 database. Results are keyed by{" "}
            <code>kind</code> so additional suites (e.g. ecosystem apps, Vitest) can be added later
            without schema changes.
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
