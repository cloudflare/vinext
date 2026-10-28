"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

/**
 * Building blocks for the benchmark charts embedded in blog posts. Series colours come
 * from the `--bench-*` custom properties in `globals.css`, which switch with the page's
 * colour scheme. Text always uses the kumo text tokens; only marks carry series colour.
 */

export type SeriesId = "redact" | "v13" | "v14" | "next";

export const SERIES_COLOR: Record<SeriesId, string> = {
  redact: "var(--bench-redact)",
  v13: "var(--bench-v13)",
  v14: "var(--bench-v14)",
  next: "var(--bench-next)",
};

export type SeriesLabels = Partial<Record<SeriesId, string>>;

const DEFAULT_LABELS: Record<SeriesId, string> = {
  redact: "Vinext 1.4 + Redact",
  v13: "Vinext 1.3",
  v14: "Vinext 1.4",
  next: "Next.js",
};

export function seriesLabel(id: SeriesId, labels?: SeriesLabels): string {
  return labels?.[id] ?? DEFAULT_LABELS[id];
}

// --- formatting ---------------------------------------------------------------

export type Format = (value: number) => string;

export const formatMs: Format = (value) =>
  value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${value % 1 === 0 ? value : value.toFixed(1)} ms`;

export function formatChange(from: number, to: number): string {
  // Past a few times the original, a multiple reads better than a four-digit percentage.
  if (to / from >= 3) return `${Math.round(to / from)}×`;
  const change = (to - from) / from;
  const rounded = Math.round(Math.abs(change) * 100);
  if (rounded === 0) return "±0%";
  return `${change < 0 ? "−" : "+"}${rounded}%`;
}

// --- hooks ----------------------------------------------------------------------

/** True once the element has scrolled into view, so bars can grow in. */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || inView) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView]);
  return [ref, inView] as const;
}

// --- tooltip --------------------------------------------------------------------

type TooltipState = { x: number; y: number; content: ReactNode } | null;

const TooltipContext = createContext<{
  show: (event: PointerEvent | FocusEvent, content: ReactNode) => void;
  hide: () => void;
} | null>(null);

/** Props that make an element show `content` in the card's tooltip on hover or focus. */
export function useTooltipTarget(content: ReactNode) {
  const tooltip = useContext(TooltipContext);
  return {
    tabIndex: 0,
    onPointerEnter: (event: PointerEvent) => tooltip?.show(event, content),
    onPointerMove: (event: PointerEvent) => tooltip?.show(event, content),
    onPointerLeave: () => tooltip?.hide(),
    onFocus: (event: FocusEvent) => tooltip?.show(event, content),
    onBlur: () => tooltip?.hide(),
  };
}

function TooltipLayer({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TooltipState>(null);
  const value = useMemo(
    () => ({
      show(event: PointerEvent | FocusEvent, content: ReactNode) {
        if ("clientX" in event) {
          setState({ x: event.clientX, y: event.clientY, content });
        } else {
          const rect = (event.currentTarget as Element).getBoundingClientRect();
          setState({ x: rect.left + rect.width / 2, y: rect.top, content });
        }
      },
      hide() {
        setState(null);
      },
    }),
    [],
  );

  return (
    <TooltipContext.Provider value={value}>
      {children}
      {state ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 min-w-40 -translate-x-1/2 -translate-y-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-xs leading-relaxed text-kumo-default shadow-lg"
          style={{ left: state.x, top: state.y - 12 }}
        >
          {state.content}
        </div>
      ) : null}
    </TooltipContext.Provider>
  );
}

export function TooltipRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-kumo-subtle">
        {color ? <Swatch color={color} /> : null}
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

// --- card -----------------------------------------------------------------------

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ background: color } satisfies CSSProperties}
    />
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-kumo-subtle">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <Swatch color={item.color} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export type TableView = {
  columns: string[];
  rows: Array<Array<string>>;
};

/**
 * A chart's frame: title and context on top, the plot, then the method and every
 * number behind the plot in a collapsible table.
 */
export function BenchCard({
  eyebrow,
  title,
  description,
  legend,
  children,
  method,
  table,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
  method: ReactNode;
  table: TableView;
}) {
  return (
    <TooltipLayer>
      <figure className="my-10 overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        <figcaption className="space-y-1.5 px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
            {eyebrow}
          </div>
          <div className="text-base font-semibold tracking-tight text-kumo-default">{title}</div>
          {description ? (
            <div className="text-sm leading-relaxed text-kumo-subtle">{description}</div>
          ) : null}
          {legend ? <div className="pt-2">{legend}</div> : null}
        </figcaption>
        <div className="px-5 py-6 sm:px-6">{children}</div>
        <details className="group border-t border-kumo-hairline bg-kumo-elevated px-5 py-3 text-xs text-kumo-subtle sm:px-6">
          <summary className="cursor-pointer list-none select-none font-medium text-kumo-default marker:hidden">
            <span className="inline-block transition-transform group-open:rotate-90">›</span> How
            this was measured
          </summary>
          <div className="mt-3 space-y-3 leading-relaxed">
            <div>{method}</div>
            <div className="overflow-x-auto">
              <table className="!my-0 !text-xs">
                <thead>
                  <tr>
                    {table.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr key={row[0]}>
                      {row.map((cell, index) => (
                        <td key={table.columns[index] || "label"} className="tabular-nums">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </figure>
    </TooltipLayer>
  );
}

// --- bars -----------------------------------------------------------------------

const BAR_TRANSITION =
  "motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out";

/** One horizontal bar with its value at the tip, growing from a square baseline. */
export function Bar({
  fraction,
  color,
  label,
  grow,
  dimmed,
  delay = 0,
  gutter = "4.5rem",
}: {
  fraction: number;
  color: string;
  label: ReactNode;
  grow: boolean;
  dimmed?: boolean;
  delay?: number;
  gutter?: string;
}) {
  const width = `${Math.max(fraction * 100, 0.6)}%`;
  // The right gutter keeps the value label inside the plot even for the longest bar.
  return (
    <div
      className="h-5 motion-safe:transition-opacity motion-safe:duration-200"
      style={{ opacity: dimmed ? 0.35 : 1, paddingRight: gutter }}
    >
      <div className="relative h-full">
        <div
          className={`absolute inset-y-[3px] left-0 rounded-r-[4px] ${BAR_TRANSITION}`}
          style={{ width: grow ? width : "0%", background: color, transitionDelay: `${delay}ms` }}
        />
        <span
          className={`absolute inset-y-0 flex items-center whitespace-nowrap pl-2 text-xs tabular-nums text-kumo-default ${BAR_TRANSITION}`}
          style={{ left: grow ? width : "0%", transitionDelay: `${delay}ms` }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
