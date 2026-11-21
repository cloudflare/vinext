"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Bar,
  BenchCard,
  formatChange,
  Legend,
  SERIES_COLOR,
  seriesLabel,
  TooltipRow,
  useInView,
  useTooltipTarget,
  type Format,
  type SeriesId,
  type SeriesLabels,
  type TableView,
} from "./primitives";

// --- metric panels ----------------------------------------------------------------

export type Metric = {
  label: string;
  better: "lower" | "higher";
  format: Format;
  values: Partial<Record<SeriesId, number>>;
};

/** Which two series a panel's headline change compares, and how to caption it. */
export type Comparison = { from: SeriesId; to: SeriesId; caption: string };

const DEFAULT_COMPARISON: Comparison = { from: "v13", to: "v14", caption: "since 1.3" };

function isBetter(metric: Metric, a: number, b: number) {
  return metric.better === "lower" ? a < b : a > b;
}

function changeTooltip(
  metric: Metric,
  id: SeriesId,
  comparison: Comparison,
  labels?: SeriesLabels,
): ReactNode {
  const value = metric.values[id]!;
  const comparisons = [comparison.from, "next" as const].filter(
    (other) => other !== id && metric.values[other] !== undefined,
  );
  return (
    <div className="space-y-1">
      <div className="font-semibold">{metric.label}</div>
      <TooltipRow
        label={seriesLabel(id, labels)}
        value={metric.format(value)}
        color={SERIES_COLOR[id]}
      />
      {comparisons.map((other) => (
        <TooltipRow
          key={other}
          label={`vs ${seriesLabel(other, labels)}`}
          value={formatChange(metric.values[other]!, value)}
        />
      ))}
    </div>
  );
}

function MetricRow({
  metric,
  id,
  max,
  grow,
  index,
  labels,
  comparison,
  active,
  onActive,
}: {
  metric: Metric;
  id: SeriesId;
  max: number;
  grow: boolean;
  index: number;
  labels?: SeriesLabels;
  comparison: Comparison;
  active: SeriesId | null;
  onActive: (id: SeriesId | null) => void;
}) {
  const value = metric.values[id]!;
  const target = useTooltipTarget(changeTooltip(metric, id, comparison, labels));
  const highlight = id === comparison.to;
  return (
    <div
      {...target}
      onPointerEnter={(event) => {
        onActive(id);
        target.onPointerEnter(event);
      }}
      onPointerLeave={() => {
        onActive(null);
        target.onPointerLeave();
      }}
      onFocus={(event) => {
        onActive(id);
        target.onFocus(event);
      }}
      onBlur={() => {
        onActive(null);
        target.onBlur();
      }}
      className="grid cursor-default grid-cols-[minmax(0,var(--bench-label-width,5.75rem))_1fr] items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-kumo-line"
    >
      <span
        className={`truncate text-xs ${highlight ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`}
      >
        {seriesLabel(id, labels)}
      </span>
      <Bar
        fraction={value / max}
        color={SERIES_COLOR[id]}
        label={metric.format(value)}
        grow={grow}
        dimmed={active !== null && active !== id}
        delay={index * 90}
      />
    </div>
  );
}

function MetricPanel({
  metric,
  series,
  labels,
  comparison,
  grow,
  active,
  onActive,
}: {
  metric: Metric;
  series: SeriesId[];
  labels?: SeriesLabels;
  comparison: Comparison;
  grow: boolean;
  active: SeriesId | null;
  onActive: (id: SeriesId | null) => void;
}) {
  const present = series.filter((id) => metric.values[id] !== undefined);
  const max = Math.max(...present.map((id) => metric.values[id]!));
  const from = metric.values[comparison.from];
  const to = metric.values[comparison.to];
  const next = metric.values.next;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-kumo-hairline bg-kumo-canvas/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-kumo-default">{metric.label}</div>
          <div className="mt-0.5 text-[0.6875rem] text-kumo-subtle">
            {metric.better === "lower" ? "↓ Lower is better" : "↑ Higher is better"}
          </div>
        </div>
        {from !== undefined && to !== undefined ? (
          <div className="text-right">
            <div className="text-xl font-semibold leading-none tracking-tight text-kumo-default">
              {formatChange(from, to)}
            </div>
            <div className="mt-1 whitespace-nowrap text-[0.6875rem] text-kumo-subtle">
              {comparison.caption}
            </div>
          </div>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {present.map((id, index) => (
          <MetricRow
            key={id}
            metric={metric}
            id={id}
            max={max}
            grow={grow}
            index={index}
            labels={labels}
            comparison={comparison}
            active={active}
            onActive={onActive}
          />
        ))}
      </div>
      {to !== undefined && next !== undefined ? (
        <div className="mt-auto border-t border-kumo-hairline pt-3 text-[0.6875rem] text-kumo-subtle">
          {isBetter(metric, to, next) ? "Ahead of" : to === next ? "Level with" : "Behind"}{" "}
          {seriesLabel("next", labels)} by{" "}
          <span className="font-medium text-kumo-default">
            {Math.round((Math.abs(to - next) / next) * 100)}%
          </span>
        </div>
      ) : null}
    </div>
  );
}

function metricTable(metrics: Metric[], series: SeriesId[], labels?: SeriesLabels): TableView {
  return {
    columns: ["", ...series.map((id) => seriesLabel(id, labels))],
    rows: metrics.map((metric) => [
      metric.label,
      ...series.map((id) =>
        metric.values[id] === undefined ? "–" : metric.format(metric.values[id]!),
      ),
    ]),
  };
}

export function MetricPanels({
  eyebrow,
  title,
  description,
  metrics,
  series = ["v13", "v14", "next"],
  labels,
  comparison = DEFAULT_COMPARISON,
  labelWidth,
  method,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  metrics: Metric[];
  series?: SeriesId[];
  labels?: SeriesLabels;
  comparison?: Comparison;
  /** Width of the series label column, for series names longer or shorter than the default. */
  labelWidth?: string;
  method: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [active, setActive] = useState<SeriesId | null>(null);
  const columns = metrics.length >= 2 ? "sm:grid-cols-2" : "";
  return (
    <BenchCard
      eyebrow={eyebrow}
      title={title}
      description={description}
      legend={
        <Legend
          items={series.map((id) => ({ label: seriesLabel(id, labels), color: SERIES_COLOR[id] }))}
        />
      }
      method={method}
      table={metricTable(metrics, series, labels)}
    >
      <div
        ref={ref}
        // A last panel on its own row spans the full width instead of leaving a gap.
        className={`grid gap-3 ${columns} sm:[&>:last-child:nth-child(odd)]:col-span-2`}
        style={labelWidth ? ({ "--bench-label-width": labelWidth } as CSSProperties) : undefined}
      >
        {metrics.map((metric) => (
          <MetricPanel
            key={metric.label}
            metric={metric}
            series={series}
            labels={labels}
            comparison={comparison}
            grow={inView}
            active={active}
            onActive={setActive}
          />
        ))}
      </div>
    </BenchCard>
  );
}

// --- highlights -----------------------------------------------------------------

export type Highlight = {
  label: string;
  value: string;
  detail: ReactNode;
  steps: Partial<Record<SeriesId, number>>;
  format: Format;
  better: "lower" | "higher";
  labels?: SeriesLabels;
};

function HighlightTile({ highlight, grow }: { highlight: Highlight; grow: boolean }) {
  const ids = (["v13", "v14", "next"] as const).filter((id) => highlight.steps[id] !== undefined);
  const max = Math.max(...ids.map((id) => highlight.steps[id]!));
  return (
    <div className="flex flex-col rounded-xl border border-kumo-hairline bg-kumo-canvas/40 p-4">
      <div className="text-xs text-kumo-subtle">{highlight.label}</div>
      <div className="mt-2 text-4xl font-semibold tracking-tight text-kumo-default">
        {highlight.value}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-kumo-subtle">{highlight.detail}</div>
      <div className="mt-auto flex h-14 items-end gap-1.5 pt-4">
        {ids.map((id, index) => (
          <HighlightStep
            key={id}
            id={id}
            highlight={highlight}
            height={highlight.steps[id]! / max}
            grow={grow}
            index={index}
          />
        ))}
      </div>
    </div>
  );
}

function HighlightStep({
  id,
  highlight,
  height,
  grow,
  index,
}: {
  id: SeriesId;
  highlight: Highlight;
  height: number;
  grow: boolean;
  index: number;
}) {
  const target = useTooltipTarget(
    <TooltipRow
      label={seriesLabel(id, highlight.labels)}
      value={highlight.format(highlight.steps[id]!)}
      color={SERIES_COLOR[id]}
    />,
  );
  return (
    <div
      {...target}
      className="relative flex h-full flex-1 items-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-kumo-line"
    >
      <div
        className="w-full rounded-t-[4px] motion-safe:transition-[height] motion-safe:duration-700 motion-safe:ease-out"
        style={{
          height: grow ? `${Math.max(height * 100, 2)}%` : "0%",
          background: SERIES_COLOR[id],
          transitionDelay: `${index * 90}ms`,
        }}
      />
    </div>
  );
}

export function Highlights({
  eyebrow,
  title,
  highlights,
  method,
}: {
  eyebrow: string;
  title: string;
  highlights: Highlight[];
  method: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const series = ["v13", "v14", "next"] as const;
  return (
    <BenchCard
      eyebrow={eyebrow}
      title={title}
      legend={
        <Legend items={series.map((id) => ({ label: seriesLabel(id), color: SERIES_COLOR[id] }))} />
      }
      method={method}
      table={{
        columns: ["", ...series.map((id) => seriesLabel(id))],
        rows: highlights.map((highlight) => [
          highlight.label,
          ...series.map((id) =>
            highlight.steps[id] === undefined ? "–" : highlight.format(highlight.steps[id]!),
          ),
        ]),
      }}
    >
      <div ref={ref} className="grid gap-3 sm:grid-cols-3">
        {highlights.map((highlight) => (
          <HighlightTile key={highlight.label} highlight={highlight} grow={inView} />
        ))}
      </div>
    </BenchCard>
  );
}

// --- Lighthouse score rings -----------------------------------------------------

export type LighthouseRun = {
  score: number;
  fcp: number;
  lcp: number;
  tbt: number;
};

function ScoreRing({
  id,
  run,
  labels,
  grow,
  index,
}: {
  id: SeriesId;
  run: LighthouseRun;
  labels?: SeriesLabels;
  grow: boolean;
  index: number;
}) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const target = useTooltipTarget(
    <div className="space-y-1">
      <div className="font-semibold">{seriesLabel(id, labels)}</div>
      <TooltipRow label="Performance score" value={String(run.score)} />
      <TooltipRow label="First Contentful Paint" value={formatSeconds(run.fcp)} />
      <TooltipRow label="Largest Contentful Paint" value={formatSeconds(run.lcp)} />
      <TooltipRow label="Total Blocking Time" value={`${run.tbt} ms`} />
    </div>,
  );
  const highlight = id === "v14";
  return (
    <div
      {...target}
      className={`flex cursor-default flex-col items-center rounded-xl border p-3 outline-none focus-visible:ring-2 focus-visible:ring-kumo-line sm:p-4 ${
        highlight ? "border-kumo-line bg-kumo-canvas/60" : "border-kumo-hairline bg-kumo-canvas/30"
      }`}
    >
      <div className="relative size-20 sm:size-24">
        <svg viewBox="0 0 88 88" className="size-full -rotate-90" aria-hidden>
          <circle
            cx="44"
            cy="44"
            r={radius}
            fill="none"
            strokeWidth="6"
            className="stroke-kumo-hairline"
            style={{ stroke: "var(--color-kumo-hairline)" }}
          />
          <circle
            cx="44"
            cy="44"
            r={radius}
            fill="none"
            strokeWidth="6"
            strokeLinecap="round"
            stroke={SERIES_COLOR[id]}
            strokeDasharray={circumference}
            strokeDashoffset={grow ? circumference * (1 - run.score / 100) : circumference}
            className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-out"
            style={{ transitionDelay: `${index * 120}ms` }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-2xl font-semibold tracking-tight text-kumo-default">
          {run.score}
        </div>
      </div>
      <div
        className={`mt-3 text-xs ${highlight ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`}
      >
        {seriesLabel(id, labels)}
      </div>
      <dl className="mt-3 grid w-full grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-[0.6875rem]">
        <dt className="text-kumo-subtle">FCP</dt>
        <dd className="text-right tabular-nums text-kumo-default">{formatSeconds(run.fcp)}</dd>
        <dt className="text-kumo-subtle">LCP</dt>
        <dd className="text-right tabular-nums text-kumo-default">{formatSeconds(run.lcp)}</dd>
        <dt className="text-kumo-subtle">TBT</dt>
        <dd className="text-right tabular-nums text-kumo-default">{run.tbt} ms</dd>
      </dl>
    </div>
  );
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)} s`;
}

export function ScoreRings({
  eyebrow,
  title,
  description,
  runs,
  labels,
  method,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  runs: Partial<Record<SeriesId, LighthouseRun>>;
  labels?: SeriesLabels;
  method: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const ids = (Object.keys(runs) as SeriesId[]).filter((id) => runs[id]);
  return (
    <BenchCard
      eyebrow={eyebrow}
      title={title}
      description={description}
      method={method}
      table={{
        columns: ["", "Score", "FCP", "LCP", "TBT"],
        rows: ids.map((id) => {
          const run = runs[id]!;
          return [
            seriesLabel(id, labels),
            String(run.score),
            formatSeconds(run.fcp),
            formatSeconds(run.lcp),
            `${run.tbt} ms`,
          ];
        }),
      }}
    >
      <div ref={ref} className="grid grid-cols-3 gap-2 sm:gap-3">
        {ids.map((id, index) => (
          <ScoreRing key={id} id={id} run={runs[id]!} labels={labels} grow={inView} index={index} />
        ))}
      </div>
    </BenchCard>
  );
}

// --- before/after bytes ---------------------------------------------------------

export type ByteRow = {
  id: SeriesId;
  bytes: number;
  requests: number;
  note?: string;
};

function ByteBar({
  row,
  max,
  grow,
  index,
  labels,
  baseline,
}: {
  row: ByteRow;
  max: number;
  grow: boolean;
  index: number;
  labels?: SeriesLabels;
  baseline: number;
}) {
  const target = useTooltipTarget(
    <div className="space-y-1">
      <div className="font-semibold">{seriesLabel(row.id, labels)}</div>
      <TooltipRow
        label="Prefetched"
        value={row.note ?? formatBytesLong(row.bytes)}
        color={SERIES_COLOR[row.id]}
      />
      <TooltipRow label="Requests" value={String(row.requests)} />
    </div>,
  );
  const ratio = row.bytes > 0 ? Math.round(baseline / row.bytes) : 0;
  return (
    <div
      {...target}
      className="grid cursor-default grid-cols-[minmax(0,var(--bench-label-width,5.75rem))_1fr] items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-kumo-line"
    >
      <span
        className={`text-xs ${row.id === "v14" ? "font-semibold text-kumo-default" : "text-kumo-subtle"}`}
      >
        {seriesLabel(row.id, labels)}
      </span>
      {row.note ? (
        <div className="flex h-7 items-center text-xs text-kumo-subtle">{row.note}</div>
      ) : (
        <div className="flex h-7 flex-col justify-center">
          <Bar
            fraction={row.bytes / max}
            color={SERIES_COLOR[row.id]}
            grow={grow}
            delay={index * 120}
            label={
              <span className="flex items-center gap-2">
                {formatBytesLong(row.bytes)}
                {ratio >= 10 ? (
                  <span className="rounded-full border border-kumo-line bg-kumo-elevated px-2 py-0.5 text-[0.6875rem] font-medium">
                    {ratio}× less
                  </span>
                ) : null}
              </span>
            }
          />
        </div>
      )}
    </div>
  );
}

function formatBytesLong(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1000).toFixed(1)} kB`;
}

export function ByteBars({
  eyebrow,
  title,
  description,
  rows,
  labels,
  method,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  rows: ByteRow[];
  labels?: SeriesLabels;
  method: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const max = Math.max(...rows.map((row) => row.bytes));
  const baseline = rows[0]?.bytes ?? max;
  return (
    <BenchCard
      eyebrow={eyebrow}
      title={title}
      description={description}
      method={method}
      table={{
        columns: ["", "Bytes prefetched", "Requests"],
        rows: rows.map((row) => [
          seriesLabel(row.id, labels),
          row.note ?? formatBytesLong(row.bytes),
          String(row.requests),
        ]),
      }}
    >
      <div ref={ref} className="space-y-2">
        {rows.map((row, index) => (
          <ByteBar
            key={row.id}
            row={row}
            max={max}
            grow={inView}
            index={index}
            labels={labels}
            baseline={baseline}
          />
        ))}
      </div>
    </BenchCard>
  );
}
