"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  individualRunsVisibilityUrl,
  resolveIndividualRunsVisibilityFromSearch,
} from "./benchmark-url-state";
import { visibleMarkerMask } from "./chart-points";
import { hasRollingMedian, rollingMedian } from "./trend";

// ─── Types ───────────────────────────────────────────────────────────────────

type Series = {
  name: string;
  color: string;
  /** One value per label. null = no data for this commit. */
  values: (number | null)[];
};

type TrendChartProps = {
  /** Shared x-axis labels (e.g. commit short hashes), same length as each series' values array. */
  labels: string[];
  /** Stable unique keys for each x-axis point, such as benchmark run IDs. */
  pointKeys: string[];
  /** Optional destination for each x-axis point. */
  pointHrefs?: string[];
  series: Series[];
  yLabel?: string;
  formatY?: (value: number) => string;
  height?: number;
};

// ─── SVG Trend Chart ─────────────────────────────────────────────────────────

const PADDING = { top: 20, right: 20, bottom: 40, left: 70 };
const TREND_WINDOW = 7;

export function TrendChart({
  labels,
  pointKeys,
  pointHrefs,
  series,
  yLabel = "",
  formatY = (v) => String(v),
  height = 300,
}: TrendChartProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const [showIndividualRuns, setShowIndividualRuns] = useState(true);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    content: string;
    pointId: string;
  } | null>(null);
  const hasTrend = series.some((item) => hasRollingMedian(item.values, TREND_WINDOW));

  useEffect(() => {
    const requestedVisibility = resolveIndividualRunsVisibilityFromSearch(window.location.search);
    setShowIndividualRuns(hasTrend ? requestedVisibility : true);

    if (!hasTrend && !requestedVisibility) {
      router.replace(
        individualRunsVisibilityUrl(
          pathname,
          new URLSearchParams(window.location.search),
          true,
          window.location.hash,
        ),
        { scroll: false },
      );
    }
  }, [hasTrend, pathname, router, searchParams]);

  // Collect all non-null values to determine y-axis bounds
  const allValues = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (allValues.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
        No data points to display
      </div>
    );
  }

  const numPoints = labels.length;
  const minVal = Math.min(...allValues) * 0.9;
  const maxVal = Math.max(...allValues) * 1.1;

  const chartWidth = 700;
  const innerW = chartWidth - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;

  function scaleX(i: number): number {
    if (numPoints <= 1) return PADDING.left + innerW / 2;
    return PADDING.left + (i / (numPoints - 1)) * innerW;
  }

  function scaleY(v: number): number {
    const range = maxVal - minVal || 1;
    return PADDING.top + innerH - ((v - minVal) / range) * innerH;
  }

  // Y-axis ticks (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minVal + ((maxVal - minVal) * i) / 4;
    return { value: v, y: scaleY(v) };
  });

  const xAxisTickCount = Math.min(numPoints, 8);
  const xAxisLabelIndexes = new Set(
    Array.from({ length: xAxisTickCount }, (_, i) =>
      xAxisTickCount === 1 ? 0 : Math.round((i * (numPoints - 1)) / (xAxisTickCount - 1)),
    ),
  );

  function buildPath(values: readonly (number | null)[]): string {
    const segments: string[] = [];
    let inSegment = false;

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === null) {
        inSegment = false;
        continue;
      }
      const command = inSegment ? "L" : "M";
      segments.push(`${command} ${scaleX(i)} ${scaleY(value)}`);
      inSegment = true;
    }

    return segments.join(" ");
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="w-full"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Grid lines */}
        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={PADDING.left}
              y1={tick.y}
              x2={chartWidth - PADDING.right}
              y2={tick.y}
              stroke="#e5e7eb"
              strokeDasharray="4 4"
            />
            <text x={PADDING.left - 8} y={tick.y + 4} textAnchor="end" fontSize="11" fill="#9ca3af">
              {formatY(tick.value)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {labels.map((label, i) => {
          if (!xAxisLabelIndexes.has(i)) return null;
          return (
            <text
              key={pointKeys[i]}
              x={scaleX(i)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === numPoints - 1 ? "end" : "middle"}
              fontSize="10"
              fill="#9ca3af"
            >
              {label}
            </text>
          );
        })}

        {/* Rolling median trendlines */}
        {series.map((s) => {
          if (hiddenSeries.has(s.name)) return null;
          const pathD = buildPath(rollingMedian(s.values, TREND_WINDOW));
          if (!pathD) return null;
          return (
            <path
              key={`${s.name}-trend`}
              d={pathD}
              fill="none"
              stroke={s.color}
              strokeWidth="2.5"
              strokeDasharray="6 4"
              strokeLinecap="round"
              opacity="0.45"
              pointerEvents="none"
            />
          );
        })}

        {/* Individual run lines + dots */}
        {series.map((s, seriesIndex) => {
          if (hiddenSeries.has(s.name)) return null;
          const pathD = buildPath(s.values);
          if (!pathD) return null;
          const visibleMarkers = visibleMarkerMask(s.values, formatY);

          return (
            <g key={s.name}>
              {/* Line */}
              <path
                d={pathD}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                opacity={showIndividualRuns ? 1 : 0}
                pointerEvents="none"
              />
              {/* Every point remains interactive; repeated plateau markers stay hidden. */}
              {s.values.map((v, i) => {
                if (v === null) return null;
                const pointId = `${seriesIndex}-${pointKeys[i]}`;
                const point = (
                  <g key={`${pointKeys[i]}-${s.name}`}>
                    <circle
                      cx={scaleX(i)}
                      cy={scaleY(v)}
                      r="3.5"
                      fill={s.color}
                      stroke="white"
                      strokeWidth="1.5"
                      opacity={
                        (showIndividualRuns && visibleMarkers[i]) || tooltip?.pointId === pointId
                          ? 1
                          : 0
                      }
                      pointerEvents="none"
                    />
                    <circle
                      cx={scaleX(i)}
                      cy={scaleY(v)}
                      r="8"
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={(e) => {
                        const rect = svgRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        setTooltip({
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top - 10,
                          content: `${s.name}: ${formatY(v)} (${labels[i]})`,
                          pointId,
                        });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  </g>
                );
                const href = pointHrefs?.[i];
                if (!href) return point;
                return (
                  <a
                    key={`${pointKeys[i]}-${s.name}`}
                    href={href}
                    aria-label={`View commit ${labels[i]} benchmark results`}
                  >
                    {point}
                  </a>
                );
              })}
            </g>
          );
        })}

        {/* Y-axis label */}
        {yLabel && (
          <text
            x={14}
            y={height / 2}
            textAnchor="middle"
            transform={`rotate(-90, 14, ${height / 2})`}
            fontSize="11"
            fill="#6b7280"
          >
            {yLabel}
          </text>
        )}
      </svg>

      {/* Chart visibility controls */}
      <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs text-gray-500">
        {series.map((s) => (
          <button
            key={s.name}
            type="button"
            aria-pressed={!hiddenSeries.has(s.name)}
            className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-gray-100 aria-pressed:text-gray-700 aria-pressed:[&>span]:opacity-100"
            onClick={() => {
              setTooltip(null);
              setHiddenSeries((current) => {
                const next = new Set(current);
                if (next.has(s.name)) next.delete(s.name);
                else next.add(s.name);
                return next;
              });
            }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full opacity-30"
              style={{ backgroundColor: s.color }}
            />
            {s.name}
          </button>
        ))}
        {hasTrend && (
          <button
            type="button"
            aria-pressed={showIndividualRuns}
            className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-gray-100 aria-pressed:text-gray-700 aria-pressed:[&>span]:opacity-100"
            onClick={() => {
              setTooltip(null);
              const visible = !showIndividualRuns;
              setShowIndividualRuns(visible);
              router.replace(
                individualRunsVisibilityUrl(
                  pathname,
                  new URLSearchParams(window.location.search),
                  visible,
                  window.location.hash,
                ),
                { scroll: false },
              );
            }}
          >
            <span className="inline-block w-4 border-t-2 border-gray-500 opacity-30" />
            Individual runs
          </button>
        )}
      </div>
      {hasTrend && (
        <div className="mt-1 text-center text-[11px] text-gray-400">
          Dashed lines show the {TREND_WINDOW}-run rolling median · Select controls to show or hide
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded bg-gray-900 px-2 py-1 text-xs text-white shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y, transform: "translate(-50%, -100%)" }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
