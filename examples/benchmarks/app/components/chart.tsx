"use client";

import { useState, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Series {
  name: string;
  color: string;
  /** One value per label. null = no data for this commit. */
  values: (number | null)[];
}

interface TrendChartProps {
  /** Shared x-axis labels (e.g. commit short hashes), same length as each series' values array. */
  labels: string[];
  series: Series[];
  yLabel?: string;
  formatY?: (value: number) => string;
  height?: number;
}

// ─── SVG Trend Chart ─────────────────────────────────────────────────────────

const PADDING = { top: 20, right: 20, bottom: 40, left: 70 };

export function TrendChart({
  labels,
  series,
  yLabel = "",
  formatY = (v) => String(v),
  height = 300,
}: TrendChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    content: string;
  } | null>(null);

  // Collect all non-null values to determine y-axis bounds
  const allValues = series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  );
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

  // X-axis labels (show every Nth)
  const labelStep = Math.max(1, Math.floor(numPoints / 8));

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="w-full"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Grid lines */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PADDING.left}
              y1={tick.y}
              x2={chartWidth - PADDING.right}
              y2={tick.y}
              stroke="#e5e7eb"
              strokeDasharray="4 4"
            />
            <text
              x={PADDING.left - 8}
              y={tick.y + 4}
              textAnchor="end"
              fontSize="11"
              fill="#9ca3af"
            >
              {formatY(tick.value)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {labels.map((label, i) => {
          if (i % labelStep !== 0 && i !== numPoints - 1) return null;
          return (
            <text
              key={i}
              x={scaleX(i)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#9ca3af"
            >
              {label}
            </text>
          );
        })}

        {/* Series lines + dots */}
        {series.map((s) => {
          // Build path segments, breaking on null values
          const segments: string[] = [];
          let inSegment = false;

          for (let i = 0; i < s.values.length; i++) {
            const v = s.values[i];
            if (v === null) {
              inSegment = false;
              continue;
            }
            const x = scaleX(i);
            const y = scaleY(v);
            if (!inSegment) {
              segments.push(`M ${x} ${y}`);
              inSegment = true;
            } else {
              segments.push(`L ${x} ${y}`);
            }
          }

          if (segments.length === 0) return null;
          const pathD = segments.join(" ");

          return (
            <g key={s.name}>
              {/* Line */}
              <path d={pathD} fill="none" stroke={s.color} strokeWidth="2" />
              {/* Dots — only for non-null values */}
              {s.values.map((v, i) => {
                if (v === null) return null;
                return (
                  <circle
                    key={i}
                    cx={scaleX(i)}
                    cy={scaleY(v)}
                    r="3.5"
                    fill={s.color}
                    stroke="white"
                    strokeWidth="1.5"
                    className="cursor-pointer"
                    onMouseEnter={(e) => {
                      const rect = svgRef.current?.getBoundingClientRect();
                      if (!rect) return;
                      setTooltip({
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top - 10,
                        content: `${s.name}: ${formatY(v)} (${labels[i]})`,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
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

      {/* Legend */}
      <div className="mt-3 flex justify-center gap-6 text-xs text-gray-500">
        {series.map((s) => (
          <div key={s.name} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.name}
          </div>
        ))}
      </div>

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
