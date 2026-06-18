"use client";

import { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Clock, Flame, MagnifyingGlassPlus, X } from "@phosphor-icons/react";
import type { FlameGraphData, PerformanceComparisonData } from "@/app/lib/benchmarks/server";
import { formatMs } from "./format";
import { PerformanceResultsTable, type PerformanceMeasurement } from "./performance-results";

type FlameGraphNode = FlameGraphData;

export type Comparison = PerformanceComparisonData;

export function PerformanceComparison({ comparison }: { comparison: Comparison }) {
  if (comparison.measurements.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        No comparable performance measurements are available.
      </div>
    );
  }

  const hasProfiles = comparison.measurements.some((measurement) => measurement.flameGraph);
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

function layoutFrames(root: FlameGraphNode) {
  const frames: PositionedFrame[] = [];
  const visit = (node: FlameGraphNode, x: number, width: number, depth: number) => {
    frames.push({ node, x, width, depth });
    let offset = x;
    for (const child of node.children ?? []) {
      const childWidth = width * (child.value / node.value);
      visit(child, offset, childWidth, depth + 1);
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
  if (!measurement.flameGraph)
    return <span className="font-medium">{measurement.implementationLabel}</span>;
  return (
    <Dialog.Root>
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
          <FlameGraph measurement={measurement} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function FlameGraph({ measurement }: { measurement: Comparison["measurements"][number] }) {
  const [focusPath, setFocusPath] = useState<FlameGraphNode[]>(
    measurement.flameGraph ? [measurement.flameGraph] : [],
  );
  const [hovered, setHovered] = useState<{ frame: PositionedFrame; x: number; y: number } | null>(
    null,
  );
  const root = focusPath.at(-1);
  if (!measurement.flameGraph || !root) return null;
  const frames = layoutFrames(root);
  const hotFrames = hottestFrames(root).slice(0, 8);
  const maxDepth = Math.max(...frames.map((frame) => frame.depth));
  const rowHeight = 42;
  const height = (maxDepth + 1) * rowHeight;

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
              {((root.value / measurement.flameGraph.value) * 100).toFixed(1)}%
            </span>
          </div>
        </div>
        {focusPath.length > 1 && (
          <button
            type="button"
            onClick={() => setFocusPath([measurement.flameGraph!])}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-700 hover:text-white"
          >
            Reset zoom
          </button>
        )}
      </div>
      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-xs leading-5 text-slate-300">
        Width is inclusive sampled thread time across the profiled subprocess tree and benchmark
        rounds, not elapsed wall time. Frames above a block are callees. Click a frame to zoom; use
        self time to find where samples actually terminate.
      </div>
      <div className="mb-4 flex flex-wrap gap-3 text-xs text-slate-300">
        <TraceLegend color="#f97316" label="vinext" />
        <TraceLegend color="#8b5cf6" label="Vite" />
        <TraceLegend color="#ec4899" label="Rolldown" />
        <TraceLegend color="#22c55e" label="Node.js" />
        <TraceLegend color="#60a5fa" label="Other" />
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
              {displayFrameName(node.name)}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-[#050816] p-3 shadow-inner shadow-black/40">
        <svg
          viewBox={`0 0 1000 ${height}`}
          className="min-w-[960px]"
          role="group"
          aria-label={`${measurement.implementationLabel} ${measurement.label} interactive flame graph`}
        >
          {frames.map((frame) => {
            const y = (maxDepth - frame.depth) * rowHeight;
            const percent = (frame.node.value / root.value) * 100;
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
                  x={frame.x + 1}
                  y={y + 2}
                  width={Math.max(frame.width - 2, 0)}
                  height={rowHeight - 4}
                  rx="5"
                  fill={frameColor(frame)}
                  stroke="#020617"
                  strokeWidth="1.25"
                />
                {frame.width > 70 && (
                  <text
                    x={frame.x + 8}
                    y={y + 26}
                    fontSize="13"
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
          {hovered.frame.node.category && hovered.frame.node.category !== "process" && (
            <div className="mt-1 uppercase tracking-wide text-slate-500">
              {hovered.frame.node.category}
            </div>
          )}
          <div className="mt-1 text-slate-300">
            Inclusive: {formatMs(hovered.frame.node.value)} ·{" "}
            {((hovered.frame.node.value / measurement.flameGraph.value) * 100).toFixed(1)}%
          </div>
          <div className="text-slate-300">
            Self: {formatMs(selfValue(hovered.frame.node))} ·{" "}
            {((selfValue(hovered.frame.node) / measurement.flameGraph.value) * 100).toFixed(1)}%
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
              key={path.map((item) => item.name).join(" > ")}
              type="button"
              onClick={() => setFocusPath(path)}
              className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-left transition hover:border-slate-700 hover:bg-slate-800"
            >
              <span className="min-w-0 truncate text-xs font-medium text-slate-200">
                {displayFrameName(node.name)}
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
    </div>
  );
}

function selfValue(node: FlameGraphNode) {
  return Math.max(
    0,
    node.value - (node.children ?? []).reduce((total, child) => total + child.value, 0),
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

function TraceLegend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
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
