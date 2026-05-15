"use client";

/**
 * GitHub-style contribution grid for compatibility test files.
 *
 * Each dot is one test file. Color encodes status:
 *   green  → all tests in the file passed
 *   orange → some tests passed, some failed (partial)
 *   red    → at least one test failed and none passed (or only failures)
 *   gray   → no verdict (all tests in the file were skipped by Next.js — via
 *            it.skip() / it.todo() / conditional runtime skips). Vinext does
 *            not add its own skips; we either run a file or filter it out
 *            of the manifest entirely.
 *
 * Hovering a dot shows the file path and counts.
 *
 * Layout: dots have a fixed pixel size and the number of columns is derived
 * from the container width at render time (via ResizeObserver). This keeps
 * dot density consistent at any viewport — wide screens get more columns and
 * fewer rows, narrow screens get fewer columns and more rows. No SVG-coord
 * scaling, so tooltip positioning math stays straightforward.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileStatus } from "@/app/lib/db/schema";

// useLayoutEffect would log a warning during SSR. Fall through to useEffect
// on the server (where there is nothing to measure anyway).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type GridCell = {
  suite: string;
  status: FileStatus;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

const COLORS: Record<FileStatus, string> = {
  pass: "#2da44e", // green
  partial: "#e08600", // orange
  fail: "#cf222e", // red
  skip: "#8c959f", // gray
};

const LABELS: Record<FileStatus, string> = {
  pass: "Pass",
  partial: "Partial",
  fail: "Fail",
  skip: "Skipped by Next.js",
};

const CELL_SIZE = 12;
const GAP = 3;
const STRIDE = CELL_SIZE + GAP;
// Default column count used during SSR and the first client render before
// the container has been measured. Picked to roughly fill a desktop card so
// the initial paint is close to the final layout; useLayoutEffect snaps to
// the real width on the first frame.
const SSR_COLS = 60;

function summarize(cell: GridCell): string {
  const parts = [`${cell.passed}/${cell.total} passed`];
  if (cell.failed > 0) parts.push(`${cell.failed} failed`);
  if (cell.skipped > 0) parts.push(`${cell.skipped} skipped`);
  const group = deriveSuiteGroup(cell.suite);
  const prefix = group ? `[${group}] ${cell.suite}` : cell.suite;
  return `${prefix} — ${LABELS[cell.status]} (${parts.join(", ")})`;
}

/**
 * Derive a display "suite" (group) label from the test file path.
 *
 * Next.js's deploy tests live under predictable directories; the first
 * meaningful path segment is a reliable bucket:
 *
 *   test/e2e/app-dir/foo.test.ts        → "app-dir"
 *   test/e2e/middleware/foo.test.ts     → "middleware"
 *   test/e2e/foo.test.ts                → "e2e"
 *   test/integration/foo.test.ts        → "integration"
 *   test/unit/foo.test.ts               → "unit"
 *
 * Returns null when the path has been collapsed to a basename (older
 * reports that don't preserve path info) — the caller hides the row.
 */
function deriveSuiteGroup(suite: string): string | null {
  if (!suite.includes("/")) return null;
  const parts = suite.split("/").filter(Boolean);
  // Strip a leading "test/" if present.
  const start = parts[0] === "test" ? 1 : 0;
  const first = parts[start];
  if (!first) return null;
  // For test/e2e/<group>/file or test/integration/<group>/file, use the
  // sub-group when there is one beyond the leaf file. Otherwise fall back
  // to the top-level directory (e.g. "e2e", "integration").
  if (parts.length - start >= 3) return parts[start + 1];
  return first;
}

export function ContributionGrid({ cells }: { cells: GridCell[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(SSR_COLS);
  const [hover, setHover] = useState<{
    cell: GridCell;
    x: number; // pixels relative to containerRef
    y: number;
  } | null>(null);

  // Measure the container synchronously before paint so the first client
  // render uses the real column count (no layout flash if the SSR guess is
  // off). After that, ResizeObserver keeps it responsive.
  useIsoLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      // Each column occupies STRIDE pixels; the last column omits the gap.
      const next = Math.max(1, Math.floor((w + GAP) / STRIDE));
      setCols(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Hide the tooltip if the cursor leaves the wrapper entirely (e.g. cursor
  // moves into a gap between cells then off the edge before triggering a
  // rect's onMouseLeave).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onLeave = () => setHover(null);
    el.addEventListener("mouseleave", onLeave);
    return () => el.removeEventListener("mouseleave", onLeave);
  }, []);

  if (cells.length === 0) {
    return (
      <div className="text-sm text-kumo-subtle">
        No test results yet. The grid will populate once the deploy suite runs.
      </div>
    );
  }

  const effectiveCols = Math.max(1, Math.min(cols, cells.length));
  const rows = Math.ceil(cells.length / effectiveCols);
  const svgWidth = effectiveCols * STRIDE - GAP;
  const svgHeight = rows * STRIDE - GAP;

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        role="img"
        aria-label={`Compatibility grid: ${cells.length} test files`}
        width={svgWidth}
        height={svgHeight}
        style={{ display: "block", maxWidth: "100%" }}
      >
        {cells.map((cell, i) => {
          const col = i % effectiveCols;
          const row = Math.floor(i / effectiveCols);
          const x = col * STRIDE;
          const y = row * STRIDE;
          return (
            <rect
              key={cell.suite}
              x={x}
              y={y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              ry={2}
              fill={COLORS[cell.status]}
              onMouseEnter={(e) => {
                const container = containerRef.current;
                if (!container) return;
                const cRect = container.getBoundingClientRect();
                const tRect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                setHover({
                  cell,
                  x: tRect.left - cRect.left + tRect.width / 2,
                  y: tRect.top - cRect.top + tRect.height + 6,
                });
              }}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: "pointer" }}
            >
              <title>{summarize(cell)}</title>
            </rect>
          );
        })}
      </svg>
      {hover
        ? (() => {
            const group = deriveSuiteGroup(hover.cell.suite);
            return (
              <div
                className="pointer-events-none absolute z-10 max-w-sm rounded-md bg-kumo-elevated px-3 py-2 text-xs text-kumo-default shadow-lg ring ring-kumo-hairline"
                style={{ left: hover.x, top: hover.y, transform: "translateX(-50%)" }}
              >
                {group ? (
                  <div className="mb-1 text-[10px] font-medium tracking-wide text-kumo-subtle uppercase">
                    {group}
                  </div>
                ) : null}
                <div className="font-mono break-all">{hover.cell.suite}</div>
                <div className="mt-1 text-kumo-subtle">{summarize(hover.cell).split(" — ")[1]}</div>
              </div>
            );
          })()
        : null}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-kumo-subtle">
        {(Object.keys(COLORS) as FileStatus[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: COLORS[s] }}
              aria-hidden="true"
            />
            <span>{LABELS[s]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
