/**
 * Shared bucketing logic for router-aware compat views.
 *
 * Three places in the UI need to slice the same set of cells (or trend
 * series) by router filter:
 *
 *   - The contribution grid filters its visible cells.
 *   - The tab bar labels the chip counts.
 *   - The stat cards show per-router pass rates / file counts.
 *
 * Doing it three times with three slightly different naming schemes was
 * a maintenance hazard (parity vs both, other vs unknown), so the
 * canonical bucketing rules live here. Everyone imports from this file.
 *
 * Convention: "Mixed" suites (router === "both") count toward BOTH the
 * App Router and Pages Router buckets. A failure in a Mixed test is a
 * real failure for both routers, so reporting it under either filter is
 * correct. This means `app.files + pages.files + unknown.files` >=
 * `total files` (parity tests are counted twice). Users see this
 * documented in the "How this works" card on /compatibility.
 */
import type { RouterKind } from "@/app/lib/db/schema";

/**
 * The filter / bucket key set used across the compat UI. Matches the
 * `compat_suite_meta.router` enum + an extra `"all"` value for the
 * "show everything" filter.
 *
 *   - "all"     — every cell (no filter)
 *   - "app"     — App Router fixtures + Mixed (both)
 *   - "pages"   — Pages Router fixtures + Mixed (both)
 *   - "both"    — Mixed only (parity / interop tests)
 *   - "unknown" — config / build / edge-runtime tests with no router fixture
 */
export type RouterFilter = "all" | RouterKind;

/** Does `cell` belong in the view selected by `filter`? */
export function cellMatchesFilter(cell: { router: RouterKind }, filter: RouterFilter): boolean {
  if (filter === "all") return true;
  if (filter === "app") return cell.router === "app" || cell.router === "both";
  if (filter === "pages") return cell.router === "pages" || cell.router === "both";
  return cell.router === filter;
}

/** Counts of cells per filter. Mixed cells are counted in app + pages too. */
type FilterCounts = Record<RouterFilter, number>;

export function countByFilter<T extends { router: RouterKind }>(cells: T[]): FilterCounts {
  const out: FilterCounts = { all: cells.length, app: 0, pages: 0, both: 0, unknown: 0 };
  for (const c of cells) {
    if (c.router === "app") out.app++;
    else if (c.router === "pages") out.pages++;
    else if (c.router === "both") {
      out.both++;
      // Mixed counts in both — see comment at the top of this file.
      out.app++;
      out.pages++;
    } else out.unknown++;
  }
  return out;
}

/** Per-bucket numeric rollup. */
type RouterBucket = {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
};

type RouterBuckets = Record<RouterFilter, RouterBucket>;

/**
 * Roll up per-cell counts into per-router buckets. Identical filter
 * semantics to `cellMatchesFilter` / `countByFilter`, but accumulates
 * passed / failed / skipped numbers in addition to file counts so the
 * stat cards can compute per-router pass rates.
 */
export function bucketByRouter<
  T extends { router: RouterKind; passed: number; failed: number; skipped: number },
>(cells: T[]): RouterBuckets {
  const empty = (): RouterBucket => ({ files: 0, passed: 0, failed: 0, skipped: 0 });
  const out: RouterBuckets = {
    all: empty(),
    app: empty(),
    pages: empty(),
    both: empty(),
    unknown: empty(),
  };

  const bump = (b: RouterBucket, c: T) => {
    b.files++;
    b.passed += c.passed;
    b.failed += c.failed;
    b.skipped += c.skipped;
  };

  for (const c of cells) {
    bump(out.all, c);
    if (c.router === "app") bump(out.app, c);
    else if (c.router === "pages") bump(out.pages, c);
    else if (c.router === "both") {
      // Mixed counts toward `both` (the standalone bucket) AND toward
      // `app` and `pages`. See top of file.
      bump(out.both, c);
      bump(out.app, c);
      bump(out.pages, c);
    } else bump(out.unknown, c);
  }
  return out;
}

/** Pass rate (0..100). Skipped tests don't count toward the denominator. */
export function bucketPassRate(b: { passed: number; failed: number }): number {
  const denom = b.passed + b.failed;
  return denom > 0 ? (b.passed / denom) * 100 : 0;
}
