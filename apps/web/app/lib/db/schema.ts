/**
 * Drizzle schema for the `vinext-metrics` D1 database.
 *
 * This database is intended to hold multiple categories of metrics over time
 * (compatibility, benchmarks, bundle sizes, etc.). To keep each metric type
 * cleanly typed and indexed, we use a namespaced-table convention rather than
 * a single generic blob table:
 *
 *   compat_runs / compat_file_results   — Next.js compat (this file)
 *   benchmark_runs / benchmark_results  — future: perf benchmarks
 *   bundle_runs / bundle_assets         — future: bundle-size tracking
 *
 * Within each metric type, `kind` is a soft sub-discriminator. For compat,
 * kind=deploy today; later we might add kind=ecosystem, kind=vitest, etc.,
 * without further schema changes.
 *
 * --- compat schema ---
 * Each compat "run" (e.g. one Next.js deploy-suite GitHub Actions run)
 * submits a batch of per-file results.
 */
import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /** Test file path, e.g. test/e2e/app-dir/foo.test.ts */
    suite: text("suite").notNull(),
    /** "pass" | "fail" | "partial" | "skip" */
    status: text("status", { enum: ["pass", "fail", "partial", "skip"] }).notNull(),
    /**
     * Which Next.js router(s) the test fixture exercises:
     *   - "app"     — App Router only (fixture has app/ with real routes, no pages/)
     *   - "pages"   — Pages Router only (fixture has pages/ with real routes, no app/)
     *   - "both"    — Parity / interop test: fixture has real routes in both
     *   - "unknown" — Test has no fixture or we couldn't classify it (config tests,
     *                 edge runtime tests, build-only tests, or pre-classifier rows)
     *
     * Populated by `scripts/classify-nextjs-suites.mjs` at ingest time from the
     * Next.js checkout used to run the suite. Stored denormalised on the file
     * row (alongside `kind`) so the UI can filter / group with a single index
     * scan, and so historical rows keep their classification even if the
     * heuristic changes later.
     */
    router: text("router", { enum: ["app", "pages", "both", "unknown"] })
      .notNull()
      .default("unknown"),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
  },
  (table) => ({
    runIdx: index("idx_compat_file_results_run").on(table.runId),
    kindSuiteIdx: index("idx_compat_file_results_kind_suite").on(table.kind, table.suite),
    kindRouterIdx: index("idx_compat_file_results_kind_router").on(table.kind, table.router),
  }),
);

export type CompatRun = typeof compatRuns.$inferSelect;
export type NewCompatRun = typeof compatRuns.$inferInsert;
export type CompatFileResult = typeof compatFileResults.$inferSelect;
export type NewCompatFileResult = typeof compatFileResults.$inferInsert;

export type FileStatus = "pass" | "fail" | "partial" | "skip";
export type RouterKind = "app" | "pages" | "both" | "unknown";
