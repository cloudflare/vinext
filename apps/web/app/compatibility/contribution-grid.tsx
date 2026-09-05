"use client";

/**
 * GitHub-style contribution grid for compatibility test files.
 *
 * Each dot is one test file. Raw pass/partial/fail/skip colors are overridden
 * by compatibility-scope colors for deferred, unsupported, and
 * Vite-equivalent suites. The raw result remains visible in the tooltip and
 * continues to contribute to the overall pass rate.
 *
 * Hovering a dot shows the file path and counts.
 *
 * Layout: dots have a fixed pixel size and the number of columns is derived
 * from the container width at render time (via ResizeObserver). This keeps
 * dot density consistent at any viewport — wide screens get more columns and
 * fewer rows, narrow screens get fewer columns and more rows. No SVG-coord
 * scaling, so tooltip positioning math stays straightforward.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import { Table as TableIcon, X } from "@phosphor-icons/react";
import type { FileStatus } from "@/app/lib/db/schema";
import { cellMatchesFilter, type RouterFilter } from "./router-buckets";
import { VITE_EQUIVALENT_LABEL, type SuiteSupportStatus } from "./suite-support";
import {
  deriveSuiteGroup,
  getDisplayStatus,
  summarize,
  LABELS,
  ROUTER_LABELS,
  SUPPORT_LABELS,
  type DisplayStatus,
  type GridCell,
} from "./compat-labels";

export type { GridCell };

// (Tabs / filter UI now lives in compatibility-views.tsx; the grid receives
// the active filter as a prop. Filter semantics — what each value means and
// how Mixed cells are counted — live in ./router-buckets.ts.)

// useLayoutEffect would log a warning during SSR. Fall through to useEffect
// on the server (where there is nothing to measure anyway).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const COLORS: Record<DisplayStatus, string> = {
  pass: "#2da44e", // green
  partial: "#e08600", // orange
  fail: "#cf222e", // red
  skip: "#afb8c1", // light gray
  deferred: "#0969da", // blue
  "needs-vite-equivalent": "#8250df", // purple
  unsupported: "#6e7781", // dark gray
};

const SUPPORT_COLORS: Record<SuiteSupportStatus, string> = {
  supported: "#2da44e",
  deferred: COLORS.deferred,
  "needs-vite-equivalent": COLORS["needs-vite-equivalent"],
  unsupported: COLORS.unsupported,
};

const LEGEND_ORDER: DisplayStatus[] = [
  "pass",
  "partial",
  "fail",
  "deferred",
  "needs-vite-equivalent",
  "unsupported",
  "skip",
];

const CELL_SIZE = 12;
const GAP = 3;
const STRIDE = CELL_SIZE + GAP;
// Default column count used during SSR and the first client render before
// the container has been measured. Picked to roughly fill a desktop card so
// the initial paint is close to the final layout; useLayoutEffect snaps to
// the real width on the first frame.
const SSR_COLS = 60;

type SupportFilter = "all" | SuiteSupportStatus;
type ResultFilter = "all" | FileStatus;

export function CompatibilityTableDialog({ cells }: { cells: GridCell[] }) {
  const [query, setQuery] = useState("");
  const [supportFilter, setSupportFilter] = useState<SupportFilter>("all");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const filteredCells = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return cells.filter((cell) => {
      if (supportFilter !== "all" && cell.supportStatus !== supportFilter) return false;
      if (resultFilter !== "all" && cell.status !== resultFilter) return false;
      if (!normalizedQuery) return true;
      return [cell.suite, cell.feature, cell.reason, ROUTER_LABELS[cell.router]]
        .filter((value): value is string => value !== null)
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [cells, query, resultFilter, supportFilter]);
  const hasFilters = query !== "" || supportFilter !== "all" || resultFilter !== "all";

  return (
    <Dialog.Root>
      <Dialog.Trigger
        render={(props) => (
          <Button
            {...props}
            size="sm"
            variant="outline"
            icon={TableIcon}
            disabled={cells.length === 0}
          >
            View table
          </Button>
        )}
      />
      <Dialog
        size="xl"
        className="flex max-h-[90vh] w-[min(96vw,80rem)] max-w-none flex-col overflow-hidden p-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-hairline px-5 py-4">
          <div>
            <Dialog.Title className="text-xl font-semibold tracking-tight text-kumo-default">
              Compatibility test files
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              Showing {filteredCells.length} of {cells.length} files for the current router filter.
              Classifications do not alter the raw test results.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                shape="square"
                size="sm"
                variant="ghost"
                icon={X}
                aria-label="Close compatibility table"
              />
            )}
          />
        </div>
        <div className="grid gap-3 border-b border-kumo-hairline bg-kumo-base px-5 py-3 sm:grid-cols-[minmax(16rem,1fr)_14rem_12rem_auto] sm:items-center">
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search test files and features"
            aria-label="Search compatibility test files"
            className="w-full"
          />
          <Select
            size="sm"
            value={supportFilter}
            onValueChange={(value) => setSupportFilter(value as SupportFilter)}
            aria-label="Filter by classification"
          >
            <Select.Option value="all">All classifications</Select.Option>
            <Select.Option value="supported">Supported</Select.Option>
            <Select.Option value="deferred">Deferred</Select.Option>
            <Select.Option value="needs-vite-equivalent">{VITE_EQUIVALENT_LABEL}</Select.Option>
            <Select.Option value="unsupported">Unsupported</Select.Option>
          </Select>
          <Select
            size="sm"
            value={resultFilter}
            onValueChange={(value) => setResultFilter(value as ResultFilter)}
            aria-label="Filter by raw result"
          >
            <Select.Option value="all">All raw results</Select.Option>
            <Select.Option value="pass">Pass</Select.Option>
            <Select.Option value="partial">Partial</Select.Option>
            <Select.Option value="fail">Fail</Select.Option>
            <Select.Option value="skip">Skipped by Next.js</Select.Option>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasFilters}
            onClick={() => {
              setQuery("");
              setSupportFilter("all");
              setResultFilter("all");
            }}
          >
            Clear
          </Button>
        </div>
        <div className="min-h-0 overflow-auto">
          <Table aria-label="Compatibility test files">
            <Table.Header sticky>
              <Table.Row>
                <Table.Head>Test file</Table.Head>
                <Table.Head>Classification</Table.Head>
                <Table.Head>Feature</Table.Head>
                <Table.Head>Raw result</Table.Head>
                <Table.Head className="text-right">Passed</Table.Head>
                <Table.Head className="text-right">Failed</Table.Head>
                <Table.Head className="text-right">Skipped</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredCells.map((cell) => (
                <Table.Row key={cell.suite}>
                  <Table.Cell className="min-w-80 font-mono text-xs break-all">
                    {cell.suite}
                  </Table.Cell>
                  <Table.Cell className="min-w-48">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: SUPPORT_COLORS[cell.supportStatus] }}
                        aria-hidden="true"
                      />
                      <span className="text-sm font-medium">
                        {SUPPORT_LABELS[cell.supportStatus]}
                      </span>
                    </div>
                    {cell.reason ? (
                      <div className="mt-1 max-w-72 text-xs text-kumo-subtle">{cell.reason}</div>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell className="min-w-56 text-sm">{cell.feature ?? "—"}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap text-sm">
                    {LABELS[cell.status]}
                  </Table.Cell>
                  <Table.Cell className="text-right font-mono text-sm">{cell.passed}</Table.Cell>
                  <Table.Cell className="text-right font-mono text-sm">{cell.failed}</Table.Cell>
                  <Table.Cell className="text-right font-mono text-sm">{cell.skipped}</Table.Cell>
                </Table.Row>
              ))}
              {filteredCells.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={7} className="py-10 text-center text-sm text-kumo-subtle">
                    No test files match these filters.
                  </Table.Cell>
                </Table.Row>
              ) : null}
            </Table.Body>
          </Table>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function ContributionGrid({
  cells,
  filter = "all",
}: {
  cells: GridCell[];
  /**
   * Router filter to apply. Owned by the parent (CompatibilityViews) so the
   * line chart and grid can share state. Defaults to "all" so the component
   * still works standalone (e.g. in storybook).
   */
  filter?: RouterFilter;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(SSR_COLS);
  const [hover, setHover] = useState<{
    cell: GridCell;
    x: number; // pixels relative to containerRef
    y: number;
  } | null>(null);

  const visibleCells = useMemo(
    () => (filter === "all" ? cells : cells.filter((c) => cellMatchesFilter(c, filter))),
    [cells, filter],
  );

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

  // Grid dimensions: clamp to >= 0 to avoid emitting an SVG with negative
  // width/height when `visibleCells` is empty (`rows * STRIDE - GAP` is
  // -GAP when rows = 0). Browsers silently coerce negative dimensions to
  // 0, but it's still invalid SVG. We also branch on emptiness below so
  // the SVG isn't rendered at all in that case — both checks are cheap
  // and the explicit clamp protects future callers that might bypass the
  // empty-state branch.
  const effectiveCols = Math.max(1, Math.min(cols, Math.max(visibleCells.length, 1)));
  const rows = Math.ceil(visibleCells.length / effectiveCols);
  const svgWidth = Math.max(0, effectiveCols * STRIDE - GAP);
  const svgHeight = Math.max(0, rows * STRIDE - GAP);

  return (
    <div ref={containerRef} className="relative w-full">
      {visibleCells.length === 0 ? (
        <div className="py-8 text-center text-sm text-kumo-subtle">
          No test files in this category.
        </div>
      ) : (
        <svg
          role="img"
          aria-label={`Compatibility grid: ${visibleCells.length} test files`}
          width={svgWidth}
          height={svgHeight}
          style={{ display: "block", maxWidth: "100%" }}
        >
          {visibleCells.map((cell, i) => {
            const displayStatus = getDisplayStatus(cell);
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
                fill={COLORS[displayStatus]}
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
      )}
      {hover
        ? (() => {
            const group = deriveSuiteGroup(hover.cell.suite);
            const routerLabel = ROUTER_LABELS[hover.cell.router];
            return (
              <div
                className="pointer-events-none absolute z-10 max-w-sm rounded-md bg-kumo-elevated px-3 py-2 text-xs text-kumo-default shadow-lg ring ring-kumo-hairline"
                style={{ left: hover.x, top: hover.y, transform: "translateX(-50%)" }}
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] font-medium tracking-wide text-kumo-subtle uppercase">
                  {group ? <span>{group}</span> : null}
                  {group ? <span aria-hidden>·</span> : null}
                  <span>{routerLabel}</span>
                </div>
                <div className="font-mono break-all">{hover.cell.suite}</div>
                <div className="mt-1 text-kumo-subtle">{summarize(hover.cell).split(" — ")[1]}</div>
                {hover.cell.feature ? (
                  <div className="mt-1 font-medium text-kumo-default">{hover.cell.feature}</div>
                ) : null}
                {hover.cell.reason ? (
                  <div className="mt-1 text-kumo-subtle">{hover.cell.reason}</div>
                ) : null}
              </div>
            );
          })()
        : null}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-kumo-subtle">
        {LEGEND_ORDER.map((s) => (
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
