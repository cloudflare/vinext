"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Clock, Flame, MagnifyingGlassPlus, X } from "@phosphor-icons/react";
import type { FlameGraphData, PerformanceComparisonData } from "@/app/lib/benchmarks/server";
import { formatMs } from "./format";
import { PerformanceResultsTable, type PerformanceMeasurement } from "./performance-results";
import { profileToFlameGraph, readGzipProfile } from "./profile";
import { filteredTraceGraph, selfValue, type TraceCategory } from "./trace";

type FlameGraphNode = FlameGraphData;

const TRACE_CATEGORIES: Array<{ category: TraceCategory; color: string; label: string }> = [
  { category: "vinext", color: "#f97316", label: "vinext" },
  { category: "vite", color: "#8b5cf6", label: "Vite" },
  { category: "rolldown", color: "#ec4899", label: "Rolldown" },
  { category: "node", color: "#22c55e", label: "Node.js" },
  { category: "other", color: "#60a5fa", label: "Other" },
];

export type Comparison = PerformanceComparisonData;

export function PerformanceComparison({ comparison }: { comparison: Comparison }) {
  if (comparison.measurements.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        No comparable performance measurements are available.
      </div>
    );
  }

  const hasProfiles = comparison.measurements.some(
    (measurement) => measurement.flameGraph || measurement.profileUrl,
  );
  const currentMeasurements = comparison.measurements.map((measurement) =>
    comparisonMeasurement(measurement, "current"),
  );
  const baselineMeasurements = comparison.measurements.flatMap((measurement) =>
    measurement.baseline ? [comparisonMeasurement(measurement, "baseline")] : [],
  );
  const hasBaseline = comparison.baseline !== null;
  const comparisonByBenchmark = new Map(
    comparison.measurements.map((measurement) => [measurement.benchmarkId, measurement]),
  );
  const scenarioCount = new Set(
    comparison.measurements.map((measurement) => measurement.scenarioId),
  ).size;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 bg-gradient-to-r from-blue-50 via-white to-emerald-50 px-6 py-6">
          <div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm text-gray-500">
                <Badge variant="secondary">{comparison.badge}</Badge>
                <span>{hasBaseline ? "Performance comparison" : "Performance results"}</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight">{comparison.title}</h1>
              <p className="mt-2 max-w-2xl text-sm text-gray-500">{comparison.description}</p>
            </div>
          </div>
        </div>
        <div
          className={`grid gap-px bg-gray-200 ${hasBaseline ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
        >
          <RunCard
            label={comparison.currentLabel}
            sha={comparison.head.shortSha}
            date={comparison.head.measuredAt}
          />
          {comparison.baseline && (
            <RunCard
              label="Baseline"
              sha={comparison.baseline.shortSha}
              date={comparison.baseline.measuredAt}
            />
          )}
          <div className="bg-white px-6 py-4">
            <div className="text-xs uppercase tracking-wide text-gray-400">Measurement</div>
            <div className="mt-1 font-medium">
              {scenarioCount} {scenarioCount === 1 ? "scenario" : "scenarios"}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {hasProfiles ? "Profiles available where captured" : "Measurements only"}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Current Performance Results</h2>
        <PerformanceResultsTable
          measurements={currentMeasurements}
          baselineMeasurements={hasBaseline ? baselineMeasurements : undefined}
          renderFrameworkLabel={(measurement) => (
            <FlameGraphDialog measurement={comparisonByBenchmark.get(measurement.benchmarkId)!} />
          )}
        />
      </section>
    </div>
  );
}

function comparisonMeasurement(
  measurement: Comparison["measurements"][number],
  side: "baseline" | "current",
): PerformanceMeasurement {
  const stats = measurement[side];
  if (!stats) throw new Error(`Missing ${side} stats for ${measurement.benchmarkId}`);
  return {
    benchmarkId: measurement.benchmarkId,
    scenarioId: measurement.scenarioId,
    suite: measurement.suite,
    label: measurement.label,
    description: measurement.description,
    implementationId: measurement.implementationId,
    implementationLabel: measurement.implementationLabel,
    unit: measurement.unit,
    lowerIsBetter: measurement.lowerIsBetter,
    ...stats,
  };
}

type PositionedFrame = {
  node: FlameGraphNode;
  x: number;
  width: number;
  depth: number;
};

const MIN_VISIBLE_FRAME_WIDTH = 0.2;

function layoutFrames(root: FlameGraphNode) {
  const frames: PositionedFrame[] = [];
  const visit = (node: FlameGraphNode, x: number, width: number, depth: number) => {
    frames.push({ node, x, width, depth });
    let offset = x;
    for (const child of node.children ?? []) {
      const childWidth = width * (child.value / node.value);
      if (childWidth >= MIN_VISIBLE_FRAME_WIDTH) {
        visit(child, offset, childWidth, depth + 1);
      }
      offset += childWidth;
    }
  };
  visit(root, 0, 1000, 0);
  return frames;
}

function frameColor(frame: PositionedFrame) {
  if (frame.node.category === "vinext") return "#f97316";
  if (frame.node.category === "vite") return "#8b5cf6";
  if (frame.node.category === "rolldown") return "#ec4899";
  if (frame.node.category === "node") return "#22c55e";
  const colors = ["#dbeafe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8"];
  return colors[Math.min(frame.depth, colors.length - 1)];
}

function FlameGraphDialog({ measurement }: { measurement: Comparison["measurements"][number] }) {
  const [flameGraph, setFlameGraph] = useState(measurement.flameGraph);
  const [profileState, setProfileState] = useState<"idle" | "loading" | "loaded" | "error">(
    measurement.flameGraph ? "loaded" : "idle",
  );
  if (!measurement.flameGraph && !measurement.profileUrl)
    return <span className="font-medium">{measurement.implementationLabel}</span>;

  const loadProfile = async () => {
    if (!measurement.profileUrl || profileState !== "idle") return;
    setProfileState("loading");
    try {
      const response = await fetch(measurement.profileUrl);
      if (!response.ok) throw new Error(`Profile request failed (${response.status})`);
      const graph = profileToFlameGraph(
        await readGzipProfile(response),
        measurement.current.rounds,
      );
      if (!graph) throw new Error("Profile contains no samples");
      setFlameGraph(graph);
      setProfileState("loaded");
    } catch (error) {
      console.error(error);
      setProfileState("error");
    }
  };

  return (
    <Dialog.Root onOpenChange={(open) => open && void loadProfile()}>
      <Dialog.Trigger
        className="font-medium text-blue-700 underline decoration-blue-300 underline-offset-4 hover:text-blue-900 hover:decoration-blue-500"
        aria-label={`Open ${measurement.implementationLabel} ${measurement.label} flame graph`}
        title="Open flame graph"
      >
        {measurement.implementationLabel}
      </Dialog.Trigger>
      <Dialog
        size="xl"
        className="flex max-h-[92vh] w-[min(94vw,76rem)] max-w-none flex-col overflow-hidden border border-slate-700 bg-slate-950 p-0 text-white shadow-2xl ring-1 ring-black/30"
      >
        <div className="flex items-start justify-between gap-6 border-b border-slate-800 bg-slate-900/80 px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-orange-400">
              <Flame size={16} weight="fill" />
              Sample profile
            </div>
            <Dialog.Title className="text-xl font-semibold tracking-tight text-white">
              {measurement.implementationLabel} · {measurement.label}
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 text-sm text-slate-400">
              Hover to inspect sampled time. Select a frame to focus on that call stack.
            </Dialog.Description>
          </div>
          <Dialog.Close
            className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition hover:border-slate-600 hover:bg-slate-700 hover:text-white"
            aria-label="Close flame graph"
          >
            <X size={18} />
          </Dialog.Close>
        </div>
        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {profileState === "loading" && (
            <div className="flex min-h-64 items-center justify-center text-sm text-slate-400">
              Loading raw profile…
            </div>
          )}
          {profileState === "error" && (
            <div className="flex min-h-64 items-center justify-center text-sm text-red-300">
              The raw profile could not be loaded.
            </div>
          )}
          {flameGraph && <FlameGraph measurement={measurement} flameGraph={flameGraph} />}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function FlameGraph({
  measurement,
  flameGraph,
}: {
  measurement: Comparison["measurements"][number];
  flameGraph: FlameGraphNode;
}) {
  const fullGraph = flameGraph;
  const [categoryFilters, setCategoryFilters] = useState<Set<TraceCategory> | null>(null);
  const activeGraph = filteredTraceGraph(fullGraph, categoryFilters);
  const [focusPath, setFocusPath] = useState<FlameGraphNode[]>(activeGraph ? [activeGraph] : []);
  const [frameQuery, setFrameQuery] = useState("");
  const [hovered, setHovered] = useState<{ frame: PositionedFrame; x: number; y: number } | null>(
    null,
  );
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const root = focusPath.at(-1);
  const frames = root ? layoutFrames(root) : [];
  const hotFrames = root ? hottestFrames(root).slice(0, 12) : [];
  const allVinextFrames = vinextFrameSummary(fullGraph);
  const filteredVinextFrames = allVinextFrames.filter((frame) => {
    const query = frameQuery.trim().toLowerCase();
    return !query || `${frame.name} ${frame.source ?? ""}`.toLowerCase().includes(query);
  });
  const maxDepth = frames.length > 0 ? Math.max(...frames.map((frame) => frame.depth)) : 0;
  const rowHeight = 24;
  const height = (maxDepth + 1) * rowHeight;

  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [activeGraph, root, height]);

  if (!fullGraph || !activeGraph || !root) return null;

  const toggleCategory = (category: TraceCategory) => {
    const nextFilters = nextCategoryFilters(categoryFilters, category);
    const nextRoot = filteredTraceGraph(fullGraph, nextFilters);
    if (!nextRoot) return;
    setCategoryFilters(nextFilters);
    setFocusPath([nextRoot]);
    setHovered(null);
  };

  return (
    <div className="relative" data-flame-root>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300">
            <Clock size={15} className="text-slate-500" />
            <span className="text-slate-500">Selected</span>
            <strong className="font-semibold text-white">{formatMs(root.value)}</strong>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300">
            <MagnifyingGlassPlus size={15} className="text-slate-500" />
            <span className="text-slate-500">Focus</span>
            <strong className="max-w-64 truncate font-semibold text-white">{root.name}</strong>
            <span className="text-slate-500">
              {((root.value / activeGraph.value) * 100).toFixed(1)}%
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {focusPath.length > 1 && (
            <button
              type="button"
              onClick={() => setFocusPath([activeGraph])}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-700 hover:text-white"
            >
              Reset zoom
            </button>
          )}
        </div>
      </div>
      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-xs leading-5 text-slate-300">
        Width is inclusive sampled thread time per benchmark round, not elapsed wall time. Click
        categories to include every stack containing that type, then add more categories to compare
        their call relationships. Unselected frames are collapsed into the nearest selected frame.
      </div>
      <div className="mb-4 flex flex-wrap gap-2 text-xs text-slate-300">
        {TRACE_CATEGORIES.map(({ category, color, label }) => (
          <TraceFilter
            key={category}
            color={color}
            label={label}
            active={categoryFilters === null || categoryFilters.has(category)}
            onClick={() => toggleCategory(category)}
          />
        ))}
      </div>
      {focusPath.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-400">
          {focusPath.map((node, index) => (
            <button
              key={focusPath
                .slice(0, index + 1)
                .map((frame) => `${frame.name}:${frame.value}`)
                .join(">")}
              type="button"
              onClick={() => setFocusPath((path) => path.slice(0, index + 1))}
              className="max-w-64 truncate rounded px-1.5 py-1 hover:bg-slate-800 hover:text-white"
            >
              {index > 0 && <span className="mr-1 text-slate-600">/</span>}
              {node.name}
            </button>
          ))}
        </div>
      )}
      <div
        ref={graphViewportRef}
        className="max-h-[55vh] overflow-auto rounded-xl border border-slate-800 bg-[#050816] p-3 shadow-inner shadow-black/40"
      >
        <svg
          viewBox={`0 0 1000 ${height}`}
          width="1000"
          height={height}
          className="block min-w-[960px]"
          role="group"
          aria-label={`${measurement.implementationLabel} ${measurement.label} interactive flame graph`}
        >
          {frames.map((frame) => {
            const y = (maxDepth - frame.depth) * rowHeight;
            const percent = (frame.node.value / root.value) * 100;
            const horizontalInset = Math.min(1, frame.width * 0.08);
            return (
              <g
                key={`${frame.node.name}-${frame.depth}-${frame.x}-${frame.width}`}
                role={frame.node.children ? "button" : undefined}
                tabIndex={frame.node.children ? 0 : undefined}
                aria-label={
                  frame.node.children
                    ? `Focus ${frame.node.name}, ${percent.toFixed(1)}% of selected samples`
                    : undefined
                }
                onClick={() => frame.node.children && setFocusPath((path) => [...path, frame.node])}
                onKeyDown={(event) => {
                  if (frame.node.children && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    setFocusPath((path) => [...path, frame.node]);
                  }
                }}
                onMouseMove={(event) => {
                  const rootBounds = event.currentTarget
                    .closest("[data-flame-root]")
                    ?.getBoundingClientRect();
                  if (!rootBounds) return;
                  setHovered({
                    frame,
                    x: event.clientX - rootBounds.left,
                    y: event.clientY - rootBounds.top,
                  });
                }}
                onMouseLeave={() => setHovered(null)}
                className={
                  frame.node.children ? "group cursor-pointer focus:outline-none" : undefined
                }
              >
                <title>{`${frame.node.name}: ${percent.toFixed(1)}%`}</title>
                <rect
                  className="group-focus:stroke-orange-400"
                  x={frame.x + horizontalInset}
                  y={y + 1}
                  width={Math.max(frame.width - horizontalInset * 2, 0.01)}
                  height={rowHeight - 2}
                  rx="4"
                  fill={frameColor(frame)}
                  stroke="#020617"
                  strokeWidth={Math.min(1.25, frame.width * 0.2)}
                />
                {frame.width > 70 && (
                  <text
                    x={frame.x + 8}
                    y={y + 16}
                    fontSize="11"
                    fontWeight="500"
                    fill={frame.depth >= 4 ? "white" : "#0f172a"}
                    pointerEvents="none"
                  >
                    {truncateFrameName(frame.node.name, frame.width)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {hovered && (
        <div
          className="pointer-events-none absolute z-[100] max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white shadow-xl"
          style={{ left: hovered.x + 6, top: hovered.y + 6 }}
        >
          <div className="font-semibold">{hovered.frame.node.name}</div>
          {hovered.frame.node.source && (
            <div className="mt-1 break-all font-mono text-[11px] text-orange-200">
              {hovered.frame.node.source}
            </div>
          )}
          <div className="mt-1 text-slate-300">
            Inclusive: {formatMs(hovered.frame.node.value)} ·{" "}
            {((hovered.frame.node.value / activeGraph.value) * 100).toFixed(1)}%
          </div>
          <div className="text-slate-300">
            Self: {formatMs(selfValue(hovered.frame.node))} ·{" "}
            {((selfValue(hovered.frame.node) / activeGraph.value) * 100).toFixed(1)}%
          </div>
        </div>
      )}
      <div className="mt-5">
        <h3 className="text-sm font-semibold text-white">Hottest frames by self samples</h3>
        <p className="mt-1 text-xs text-slate-400">
          Frames where the profiler most often observed execution, excluding time in children.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {hotFrames.map(({ node, path, self }) => (
            <button
              key={path.map((item) => `${item.name}:${item.source ?? ""}`).join(" > ")}
              type="button"
              onClick={() => setFocusPath(path)}
              className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-left transition hover:border-slate-700 hover:bg-slate-800"
            >
              <span className="min-w-0 truncate text-xs font-medium text-slate-200">
                {node.name}
                {node.source && (
                  <span className="ml-1 text-slate-500">· {shortSource(node.source)}</span>
                )}
              </span>
              <span className="shrink-0 font-mono text-xs text-orange-300">
                {formatMs(self)} self
              </span>
            </button>
          ))}
        </div>
      </div>
      {allVinextFrames.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">
                All sampled vinext functions ({filteredVinextFrames.length})
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Complete inventory from the captured call tree, sorted by inclusive samples.
              </p>
            </div>
            <input
              type="search"
              value={frameQuery}
              onChange={(event) => setFrameQuery(event.target.value)}
              placeholder="Filter function or source"
              className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none placeholder:text-slate-500 focus:border-orange-400"
            />
          </div>
          <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Function</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Inclusive</th>
                  <th className="px-3 py-2 text-right font-medium">Self</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredVinextFrames.map((frame) => (
                  <tr key={`${frame.name}:${frame.source}`} className="bg-slate-950/40">
                    <td className="px-3 py-2 font-medium text-orange-200">{frame.name}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-400">
                      {frame.source ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-200">
                      {formatMs(frame.inclusive)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-200">
                      {formatMs(frame.self)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function hottestFrames(root: FlameGraphNode) {
  const frames: Array<{ node: FlameGraphNode; path: FlameGraphNode[]; self: number }> = [];
  const visit = (node: FlameGraphNode, path: FlameGraphNode[]) => {
    const nextPath = [...path, node];
    const self = selfValue(node);
    if (self > 0 && node !== root) frames.push({ node, path: nextPath, self });
    for (const child of node.children ?? []) visit(child, nextPath);
  };
  visit(root, []);
  return frames.toSorted((left, right) => right.self - left.self);
}

function vinextFrameSummary(root: FlameGraphNode) {
  const frames = new Map<
    string,
    { name: string; source?: string; inclusive: number; self: number }
  >();
  const visit = (node: FlameGraphNode) => {
    if (node.category === "vinext" && node.source) {
      const key = `${node.name}\0${node.source}`;
      const frame = frames.get(key) ?? {
        name: node.name,
        source: node.source,
        inclusive: 0,
        self: 0,
      };
      frame.inclusive += node.value;
      frame.self += selfValue(node);
      frames.set(key, frame);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return Array.from(frames.values()).toSorted(
    (left, right) => right.inclusive - left.inclusive || right.self - left.self,
  );
}

function nextCategoryFilters(
  filters: Set<TraceCategory> | null,
  category: TraceCategory,
): Set<TraceCategory> | null {
  if (filters === null) return new Set([category]);
  const next = new Set(filters);
  if (next.has(category)) {
    if (next.size === 1) return null;
    next.delete(category);
  } else {
    next.add(category);
  }
  return next.size === TRACE_CATEGORIES.length ? null : next;
}

function displayFrameName(name: string) {
  return name;
}

function truncateFrameName(name: string, width: number) {
  const displayName = displayFrameName(name);
  return displayName.length > width / 7
    ? `${displayName.slice(0, Math.max(Math.floor(width / 7) - 1, 3))}…`
    : displayName;
}

function shortSource(source: string) {
  const parts = source.split("/");
  return parts.slice(-3).join("/");
}

function TraceFilter({
  color,
  label,
  active,
  onClick,
}: {
  color: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-medium transition ${active ? "border-slate-600 bg-slate-800 text-white" : "border-slate-800 bg-slate-950 text-slate-500 opacity-60 hover:opacity-100"}`}
    >
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </button>
  );
}

function RunCard({ label, sha, date }: { label: string; sha: string; date: string }) {
  return (
    <div className="bg-white px-6 py-4">
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{sha}</div>
      <div className="mt-1 text-xs text-gray-500">{new Date(date).toLocaleString()}</div>
    </div>
  );
}
