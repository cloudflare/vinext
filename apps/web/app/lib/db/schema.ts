/**
 * Drizzle schema for the `vinext-metrics` D1 database.
 *
 * This database is intended to hold multiple categories of metrics over time
 * (compatibility, benchmarks, bundle sizes, etc.). To keep each metric type
 * cleanly typed and indexed, we use a namespaced-table convention rather than
 * a single generic blob table:
 *
 *   compat_runs / compat_file_results                 — Next.js compatibility
 *   performance_runs / performance_measurements       — generic performance scenarios
 *
 * Within each metric type, `kind` is a soft sub-discriminator. For compat,
 * kind=deploy today; later we might add kind=ecosystem, kind=vitest, etc.,
 * without further schema changes.
 *
 * --- compat schema ---
 * Each compat "run" (e.g. one Next.js deploy-suite GitHub Actions run)
 * submits a batch of per-file results.
 */
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  primaryKey,
  customType,
} from "drizzle-orm/sqlite-core";

const real = customType<{ data: number; driverData: number }>({
  dataType() {
    return "real";
  },
});

export const compatRuns = sqliteTable(
  "compat_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    /** Stable id for the run (e.g. GitHub Actions run_id). */
    runKey: text("run_key").notNull(),
    /** vinext branch or sha that produced these results. */
    vinextRef: text("vinext_ref"),
    /** Next.js ref the suite was run against (e.g. v16.2.6). */
    nextRef: text("next_ref"),
    /** vinext commit sha. */
    commitSha: text("commit_sha"),
    /** Unix millis. */
    createdAt: integer("created_at").notNull(),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
  },
  (table) => ({
    kindRunKey: uniqueIndex("compat_runs_kind_run_key").on(table.kind, table.runKey),
    kindCreated: index("idx_compat_runs_kind_created").on(table.kind, table.createdAt),
  }),
);

export const compatFileResults = sqliteTable(
  "compat_file_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => compatRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** Test file path, e.g. test/e2e/app-dir/foo.test.ts — joins to compat_suite_meta.suite. */
    suite: text("suite").notNull(),
    /** "pass" | "fail" | "partial" | "skip" */
    status: text("status", { enum: ["pass", "fail", "partial", "skip"] }).notNull(),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
  },
  (table) => ({
    runIdx: index("idx_compat_file_results_run").on(table.runId),
    kindSuiteIdx: index("idx_compat_file_results_kind_suite").on(table.kind, table.suite),
  }),
);

/**
 * Per-test-file metadata. One row per Next.js test file, globally —
 * classifications are conceptually about the test file, not about a run.
 *
 * Populated independently of result ingestion by the workflow's
 * "Classify Next.js suites" step (which POSTs to /api/compatibility/classify
 * after building the suite → router map from the Next.js checkout). This
 * decouples classification cadence from result cadence:
 *   - Bumping the Next.js ref can re-classify everything in one POST.
 *   - Fixing a heuristic bug or adding an override can update the table
 *     without re-running tests.
 *   - The /compatibility UI joins on `suite` to colour each result row.
 *
 * Trade-off: classification changes are retroactive (historical pass
 * rates split-by-router shift when a suite is reclassified). This is
 * usually what you want — corrections heal the whole history — but means
 * the chart isn't a strict point-in-time record. `classified_at` lets
 * you tie a reclassification to a moment in time; if you also need the
 * Next.js ref that produced it, join against the most recent
 * compat_runs row at or before that timestamp.
 */
export const compatSuiteMeta = sqliteTable(
  "compat_suite_meta",
  {
    /** Test file path, e.g. test/e2e/app-dir/foo.test.ts. */
    suite: text("suite").primaryKey(),
    /**
     * Which Next.js router(s) the test fixture exercises:
     *   - "app"     — App Router only (fixture has app/ with real routes, no pages/)
     *   - "pages"   — Pages Router only (fixture has pages/ with real routes, no app/)
     *   - "both"    — Parity / interop test: fixture has real routes in both
     *   - "unknown" — Test has no on-disk fixture (config / build / edge-runtime
     *                 tests, or pre-classifier rows that haven't been ingested yet)
     */
    router: text("router", { enum: ["app", "pages", "both", "unknown"] }).notNull(),
    /** Unix millis the classification was last (re)computed. */
    classifiedAt: integer("classified_at").notNull(),
  },
  (table) => ({
    routerIdx: index("idx_compat_suite_meta_router").on(table.router),
  }),
);

export const performanceRuns = sqliteTable(
  "performance_runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["main", "pull_request"] }).notNull(),
    commitSha: text("commit_sha").notNull(),
    baseSha: text("base_sha"),
    pullRequest: integer("pull_request"),
    measuredAt: text("measured_at").notNull(),
    provider: text("provider").notNull(),
    instrument: text("instrument").notNull(),
    repository: text("repository").notNull(),
    systemJson: text("system_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    kindCommit: uniqueIndex("performance_runs_kind_commit").on(table.kind, table.commitSha),
    pullRequestLatest: index("idx_performance_runs_pr_latest")
      .on(table.pullRequest, table.measuredAt)
      .where(sql`${table.kind} = 'pull_request'`),
    mainCommit: index("idx_performance_runs_main_commit")
      .on(table.commitSha, table.measuredAt)
      .where(sql`${table.kind} = 'main'`),
    mainLatest: index("idx_performance_runs_main_latest")
      .on(table.measuredAt)
      .where(sql`${table.kind} = 'main'`),
  }),
);

export const performanceProfileObjects = sqliteTable("performance_profile_objects", {
  objectKey: text("object_key").primaryKey(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const performanceMeasurements = sqliteTable(
  "performance_measurements",
  {
    runId: text("run_id")
      .notNull()
      .references(() => performanceRuns.id, { onDelete: "cascade" }),
    benchmarkId: text("benchmark_id").notNull(),
    scenarioId: text("scenario_id").notNull(),
    suite: text("suite").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    implementationId: text("implementation_id").notNull(),
    implementationLabel: text("implementation_label").notNull(),
    unit: text("unit").notNull(),
    lowerIsBetter: integer("lower_is_better", { mode: "boolean" }).notNull().default(true),
    rounds: integer("rounds").notNull(),
    meanValue: real("mean_value").notNull(),
    medianValue: real("median_value").notNull(),
    standardDeviationValue: real("standard_deviation_value").notNull(),
    minValue: real("min_value").notNull(),
    maxValue: real("max_value").notNull(),
    q1Value: real("q1_value").notNull(),
    q3Value: real("q3_value").notNull(),
    outliers: integer("outliers").notNull(),
    pairedBaselineRounds: integer("paired_baseline_rounds"),
    pairedBaselineMeanValue: real("paired_baseline_mean_value"),
    pairedBaselineMedianValue: real("paired_baseline_median_value"),
    pairedBaselineStandardDeviationValue: real("paired_baseline_standard_deviation_value"),
    pairedBaselineMinValue: real("paired_baseline_min_value"),
    pairedBaselineMaxValue: real("paired_baseline_max_value"),
    pairedBaselineQ1Value: real("paired_baseline_q1_value"),
    pairedBaselineQ3Value: real("paired_baseline_q3_value"),
    pairedBaselineOutliers: integer("paired_baseline_outliers"),
    flameGraphJson: text("flame_graph_json"),
    profileRounds: integer("profile_rounds"),
    profileObjectKey: text("profile_object_key").references(
      () => performanceProfileObjects.objectKey,
    ),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.runId, table.benchmarkId] }),
    dashboard: index("idx_performance_measurements_dashboard").on(
      table.runId,
      table.suite,
      table.label,
      table.implementationLabel,
    ),
  }),
);

export type CompatRun = typeof compatRuns.$inferSelect;
export type NewCompatRun = typeof compatRuns.$inferInsert;
export type CompatFileResult = typeof compatFileResults.$inferSelect;
export type NewCompatFileResult = typeof compatFileResults.$inferInsert;
export type CompatSuiteMeta = typeof compatSuiteMeta.$inferSelect;
export type NewCompatSuiteMeta = typeof compatSuiteMeta.$inferInsert;
export type PerformanceRun = typeof performanceRuns.$inferSelect;
export type PerformanceMeasurement = typeof performanceMeasurements.$inferSelect;

export type FileStatus = "pass" | "fail" | "partial" | "skip";
export type RouterKind = "app" | "pages" | "both" | "unknown";
