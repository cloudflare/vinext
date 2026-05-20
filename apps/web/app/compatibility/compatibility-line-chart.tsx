"use client";

/**
 * Pass-rate over time. One point per recorded run, oldest left to newest right.
 * Pure SVG — no ECharts dependency. Hover shows date + pass rate.
 *
 * The chart respects a router filter, owned by the parent (CompatibilityViews).
 * Each TrendPoint carries per-router rollups (`all` / `app` / `pages` / `both`
 * / `unknown`); the active filter picks which slice to plot. That keeps the
 * query work on the server (one round-trip producing all five series) and the
 * filter switch on the client (instant — just a re-selection from existing
 * data, no fetch).
 *
 * "app" and "pages" series include parity ("both") tests, mirroring how the
 * grid's filters work. See compatibility-views.tsx for the rationale.
 */
import { useMemo, useState } from "react";
import type { RouterFilter } from "./router-buckets";

type SeriesCounts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type TrendPoint = {
  createdAt: number;
  /**
   * Counts per router bucket for this run. "app" and "pages" include parity
   * suites; "both" is parity-only; "all" is the run-level totals (matches
   * compat_runs.{total,passed,failed,skipped}).
   */
  byRouter: Record<RouterFilter, SeriesCounts>;
};

const W = 800;
const H = 280;
const PADDING = { top: 16, right: 16, bottom: 28, left: 40 };

// Date formatting is pinned to en-US so server and client agree (this is a
// client component, so SSR runs in node which defaults to en-US, while the
// browser uses the visitor's locale — that mismatch breaks hydration).
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const FULL_DATETIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatDate(ms: number): string {
  return SHORT_DATE.format(new Date(ms));
}

function formatDateTime(ms: number): string {
  return FULL_DATETIME.format(new Date(ms));
}

/**
 * Pass rate as a 0..1 ratio (NOT a percentage). Excludes skipped tests:
 * skipped → "not relevant", not "failure". Denominator is passed + failed
 * (the tests that actually ran a verdict). Returns 0 when nothing ran
 * (rather than NaN).
 *
 * Distinct name from `bucketPassRate` (in router-buckets.ts) which returns
 * 0..100 — the chart needs a ratio for plotting Y coordinates, while the
 * stat cards need a percentage for display.
 */
function computePassRateRatio(c: SeriesCounts): number {
  const denom = c.passed + c.failed;
  return denom > 0 ? c.passed / denom : 0;
}

export function CompatibilityLineChart({
  points,
  filter = "all",
}: {
  points: TrendPoint[];
  /**
   * Which router series to plot. Defaults to "all" (run-level totals) so the
   * component still works standalone.
   */
  filter?: RouterFilter;
}) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  // Reduce TrendPoint → { createdAt, counts, passRate } for the selected
  // filter. Recomputed when filter changes, but that's a cheap O(n) over
  // ≤90 points so no measurable cost.
  const series = useMemo(
    () =>
      points.map((p) => {
        const counts = p.byRouter[filter];
        return { createdAt: p.createdAt, counts, passRate: computePassRateRatio(counts) };
      }),
    [points, filter],
  );

  const view = useMemo(() => {
    if (series.length === 0) return null;
    const xs = series.map((p) => p.createdAt);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const xRange = maxX - minX || 1;
    const plotW = W - PADDING.left - PADDING.right;
    const plotH = H - PADDING.top - PADDING.bottom;
    const xy = series.map((p, i) => {
      const x =
        series.length === 1
          ? PADDING.left + plotW / 2
          : PADDING.left + ((p.createdAt - minX) / xRange) * plotW;
      const y = PADDING.top + (1 - p.passRate) * plotH;
      return { x, y, index: i };
    });
    return { xy, minX, maxX, plotW, plotH };
  }, [series]);

  if (!view || series.length === 0) {
    return (
      <div className="text-sm text-kumo-subtle">
        No historical data yet. Once multiple runs are recorded, a trend line will appear here.
      </div>
    );
  }

  const path = view.xy.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  // Y-axis ticks at 0, 25, 50, 75, 100%.
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const plotH = view.plotH;

  return (
    <div className="relative">
      <svg
        role="img"
        aria-label="Compatibility pass rate over time"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: "100%", display: "block" }}
      >
        {/* Y gridlines + labels */}
        {yTicks.map((t) => {
          const y = PADDING.top + (1 - t) * plotH;
          return (
            <g key={t}>
              <line
                x1={PADDING.left}
                x2={W - PADDING.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.1}
                strokeDasharray="2 3"
              />
              <text
                x={PADDING.left - 6}
                y={y + 3}
                fontSize={10}
                textAnchor="end"
                fill="currentColor"
                fillOpacity={0.55}
              >
                {Math.round(t * 100)}%
              </text>
            </g>
          );
        })}

        {/* X-axis date labels (first, middle, last) */}
        {[0, Math.floor(view.xy.length / 2), view.xy.length - 1]
          .filter((idx, i, arr) => arr.indexOf(idx) === i)
          .map((idx) => {
            const p = view.xy[idx];
            return (
              <text
                key={idx}
                x={p.x}
                y={H - 8}
                fontSize={10}
                textAnchor="middle"
                fill="currentColor"
                fillOpacity={0.55}
              >
                {formatDate(series[idx].createdAt)}
              </text>
            );
          })}

        {/* Line */}
        <path d={path} fill="none" stroke="#2da44e" strokeWidth={2} strokeLinejoin="round" />

        {/* Points */}
        {view.xy.map((p, i) => (
          <circle
            key={series[i].createdAt}
            cx={p.x}
            cy={p.y}
            r={4}
            fill="#2da44e"
            stroke="var(--color-kumo-base, #fff)"
            strokeWidth={1.5}
            onMouseEnter={() => setHover({ index: i, x: p.x, y: p.y })}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: "pointer" }}
          />
        ))}
      </svg>

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-kumo-elevated px-3 py-2 text-xs text-kumo-default shadow-lg ring ring-kumo-hairline"
          style={{
            left: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 8px))",
          }}
        >
          {(() => {
            const p = series[hover.index];
            // Pass rate is computed against tests that ran a verdict, so
            // the denominator the user sees should match: passed + failed.
            const denom = p.counts.passed + p.counts.failed;
            const parts = [`${p.counts.passed}/${denom} passed`];
            if (p.counts.failed > 0) parts.push(`${p.counts.failed} failed`);
            if (p.counts.skipped > 0) parts.push(`${p.counts.skipped} skipped`);
            return (
              <>
                <div className="font-medium">{(p.passRate * 100).toFixed(1)}% pass rate</div>
                <div className="mt-1 text-kumo-subtle">{formatDateTime(p.createdAt)}</div>
                <div className="text-kumo-subtle">{parts.join(", ")}</div>
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}
