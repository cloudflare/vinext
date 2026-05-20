"use client";

/**
 * Client wrapper that owns the router-filter state shared by the contribution
 * grid and the line chart. Lifting state up here lets a single Tabs control
 * filter both visualisations in lockstep — the alternative (two independent
 * filter rows, or one row that lives inside one of the components and somehow
 * mirrors to the other) is worse for users and worse for the code.
 *
 * State scope: router filter only. The grid still owns its own internal
 * concerns (column-count measurement, hover tooltip, etc.).
 *
 * The trend chart receives full per-router series (one number per router per
 * run) from the server and picks the right slice based on the filter, so no
 * extra fetches happen when the user changes the tab.
 */
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useMemo, useState } from "react";
import { CompatibilityLineChart, type TrendPoint } from "./compatibility-line-chart";
import { ContributionGrid, type GridCell, type RouterFilter } from "./contribution-grid";

/**
 * Tab definitions for the router filter. Mirrors the bucket logic in
 * ContributionGrid — keep these two lists in sync.
 *
 *   - "all"     — show every test file
 *   - "app"     — App Router fixtures + parity (these test files exercise app)
 *   - "pages"   — Pages Router fixtures + parity
 *   - "both"    — parity-only (files that exercise both routers)
 *   - "unknown" — config / build / edge-runtime tests with no router fixture
 */
const TABS: ReadonlyArray<{ value: RouterFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "app", label: "App Router" },
  { value: "pages", label: "Pages Router" },
  { value: "both", label: "Mixed (both)" },
  { value: "unknown", label: "Other" },
];

export function CompatibilityViews({ cells, trend }: { cells: GridCell[]; trend: TrendPoint[] }) {
  const [filter, setFilter] = useState<RouterFilter>("all");

  // Count per filter — fed into the tab labels so users can see how many
  // files each filter would show before clicking. Recomputed only when
  // cells changes, not when filter changes.
  const counts = useMemo(() => {
    const c: Record<RouterFilter, number> = {
      all: cells.length,
      app: 0,
      pages: 0,
      both: 0,
      unknown: 0,
    };
    for (const cell of cells) {
      if (cell.router === "app") c.app++;
      else if (cell.router === "pages") c.pages++;
      else if (cell.router === "both") {
        c.both++;
        // Parity / mixed cells count toward both router buckets — a failure
        // in a mixed test is a real failure for both routers, so showing it
        // under either filter is correct.
        c.app++;
        c.pages++;
      } else c.unknown++;
    }
    return c;
  }, [cells]);

  const tabItems = useMemo(
    () =>
      TABS.map((t) => ({
        value: t.value,
        // Kumo Tabs accepts ReactNode as a label, but we use a plain string
        // with a parenthesised count — keeps the segmented control compact
        // and matches the dashboard's typography elsewhere.
        label: `${t.label} (${counts[t.value]})`,
      })),
    [counts],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Tabs
          tabs={tabItems}
          value={filter}
          onValueChange={(v) => setFilter(v as RouterFilter)}
          variant="segmented"
          size="sm"
        />
      </div>

      <section>
        <h3 className="mb-3 text-sm font-medium text-kumo-subtle">Test files</h3>
        <ContributionGrid cells={cells} filter={filter} />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-kumo-subtle">Compatibility over time</h3>
        <CompatibilityLineChart points={trend} filter={filter} />
      </section>
    </div>
  );
}
