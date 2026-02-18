"use client";

import { useState, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DataPoint {
  label: string;
  value: number;
}

interface Series {
  name: string;
  color: string;
  points: DataPoint[];
}

interface TrendChartProps {
  series: Series[];
  yLabel?: string;
  formatY?: (value: number) => string;
  height?: number;
}

// ─── SVG Trend Chart ─────────────────────────────────────────────────────────

const PADDING = { top: 20, right: 20, bottom: 40, left: 70 };

export function TrendChart({
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

  // Determine data bounds
  const allValues = series.flatMap((s) => s.points.map((p) => p.value));
  if (allValues.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
        No data points to display
      </div>
    );
  }

  const maxPoints = Math.max(...series.map((s) => s.points.length));
  const minVal = Math.min(...allValues) * 0.9;
  const maxVal = Math.max(...allValues) * 1.1;

  const chartWidth = 700;
  const innerW = chartWidth - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;

  function scaleX(i: number): number {
    if (maxPoints <= 1) return PADDING.left + innerW / 2;
    return PADDING.left + (i / (maxPoints - 1)) * innerW;
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

  // X-axis labels (use first series for labels, show every Nth)
  const labels = series[0]?.points || [];
  const labelStep = Math.max(1, Math.floor(labels.length / 8));

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
        {labels.map((point, i) => {
          if (i % labelStep !== 0 && i !== labels.length - 1) return null;
          return (
            <text
              key={i}
              x={scaleX(i)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#9ca3af"
            >
              {point.label}
            </text>
          );
        })}

        {/* Series lines + dots */}
        {series.map((s) => {
          if (s.points.length === 0) return null;

          const pathD = s.points
            .map((p, i) => {
              const x = scaleX(i);
              const y = scaleY(p.value);
              return `${i === 0 ? "M" : "L"} ${x} ${y}`;
            })
            .join(" ");

          return (
            <g key={s.name}>
              {/* Line */}
              <path d={pathD} fill="none" stroke={s.color} strokeWidth="2" />
              {/* Dots */}
              {s.points.map((p, i) => (
                <circle
                  key={i}
                  cx={scaleX(i)}
                  cy={scaleY(p.value)}
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
                      content: `${s.name}: ${formatY(p.value)} (${p.label})`,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
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
