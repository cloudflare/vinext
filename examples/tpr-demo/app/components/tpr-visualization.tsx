"use client";

import { useState, useMemo } from "react";
import {
  generateTrafficData,
  calculateCoverage,
  type TrafficEntry,
} from "../data";

const TOTAL_PAGES = 504; // 500 products + 4 static pages
const traffic = generateTrafficData(500);

// ─── Helpers ─────────────────────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

/** Format a millisecond duration as a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** Estimate build time for a given page count (~50ms per page). */
function estimateBuildTime(pages: number): string {
  return formatDuration(pages * 50);
}

// ─── Power Law Chart (SVG) ───────────────────────────────────

function TrafficChart({
  data,
  coverage,
}: {
  data: TrafficEntry[];
  coverage: ReturnType<typeof calculateCoverage>;
}) {
  const W = 1000;
  const H = 300;
  const PAD = { top: 10, right: 20, bottom: 40, left: 60 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxReq = data[0]?.requests ?? 1;

  // Build the area path
  const points = data.map((d, i) => {
    const x = PAD.left + (i / (data.length - 1)) * chartW;
    const y = PAD.top + chartH - (d.requests / maxReq) * chartH;
    return { x, y };
  });

  const areaPath =
    `M ${points[0].x} ${points[0].y} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x} ${p.y}`)
      .join(" ") +
    ` L ${points[points.length - 1].x} ${PAD.top + chartH}` +
    ` L ${points[0].x} ${PAD.top + chartH} Z`;

  const linePath =
    `M ${points[0].x} ${points[0].y} ` +
    points
      .slice(1)
      .map((p) => `L ${p.x} ${p.y}`)
      .join(" ");

  // Coverage threshold line
  const thresholdX =
    PAD.left +
    ((coverage.pagesNeeded - 1) / (data.length - 1)) * chartW;

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    y: PAD.top + chartH - pct * chartH,
    label: formatNum(Math.round(maxReq * pct)),
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="prerenderedGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line
            x1={PAD.left}
            y1={tick.y}
            x2={W - PAD.right}
            y2={tick.y}
            stroke="var(--border)"
            strokeDasharray="4 4"
          />
          <text
            x={PAD.left - 10}
            y={tick.y + 4}
            textAnchor="end"
            fill="var(--muted)"
            fontSize="11"
            fontFamily="var(--mono)"
          >
            {tick.label}
          </text>
        </g>
      ))}

      {/* Full traffic area */}
      <path d={areaPath} fill="url(#areaGrad)" />

      {/* Pre-rendered area (clipped to threshold) */}
      <clipPath id="prerenderedClip">
        <rect
          x={PAD.left}
          y={PAD.top}
          width={thresholdX - PAD.left}
          height={chartH}
        />
      </clipPath>
      <path
        d={areaPath}
        fill="url(#prerenderedGrad)"
        clipPath="url(#prerenderedClip)"
      />

      {/* Traffic line */}
      <path
        d={linePath}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Threshold line */}
      <line
        x1={thresholdX}
        y1={PAD.top}
        x2={thresholdX}
        y2={PAD.top + chartH}
        stroke="var(--green)"
        strokeWidth="2"
        strokeDasharray="6 4"
      />

      {/* Threshold label */}
      <text
        x={thresholdX}
        y={PAD.top - 2}
        textAnchor="middle"
        fill="var(--green)"
        fontSize="11"
        fontWeight="600"
        fontFamily="var(--mono)"
      >
        {coverage.pagesNeeded} pages
      </text>

      {/* "Pre-rendered" label */}
      <text
        x={PAD.left + (thresholdX - PAD.left) / 2}
        y={PAD.top + chartH / 2}
        textAnchor="middle"
        fill="var(--green)"
        fontSize="13"
        fontWeight="600"
        opacity="0.7"
      >
        Pre-rendered
      </text>

      {/* "SSR on demand" label */}
      {thresholdX < W - PAD.right - 80 && (
        <text
          x={thresholdX + (W - PAD.right - thresholdX) / 2}
          y={PAD.top + chartH / 2}
          textAnchor="middle"
          fill="var(--muted)"
          fontSize="12"
          fontWeight="500"
          opacity="0.6"
        >
          SSR on demand
        </text>
      )}

      {/* X-axis label */}
      <text
        x={PAD.left + chartW / 2}
        y={H - 5}
        textAnchor="middle"
        fill="var(--muted)"
        fontSize="12"
      >
        Pages ranked by traffic (most popular &rarr; least)
      </text>

      {/* Y-axis label */}
      <text
        x={12}
        y={PAD.top + chartH / 2}
        textAnchor="middle"
        fill="var(--muted)"
        fontSize="12"
        transform={`rotate(-90, 12, ${PAD.top + chartH / 2})`}
      >
        Requests
      </text>
    </svg>
  );
}

// ─── Build Time Comparison Bars ──────────────────────────────

function ComparisonBars({
  tprPages,
  totalPages,
}: {
  tprPages: number;
  totalPages: number;
}) {
  const ssgTime = totalPages * 50; // 50ms per page (in ms)
  const tprTime = tprPages * 50;
  const maxTime = ssgTime;

  const rows = [
    {
      label: "SSG",
      pages: totalPages,
      time: ssgTime,
      color: "var(--red)",
      bg: "var(--red-dim)",
    },
    {
      label: "ISR",
      pages: totalPages,
      time: ssgTime,
      color: "var(--blue)",
      bg: "var(--blue-dim)",
      note: "(builds all known pages)",
    },
    {
      label: "TPR",
      pages: tprPages,
      time: tprTime,
      color: "var(--green)",
      bg: "var(--green-dim)",
    },
    {
      label: "SSR only",
      pages: 0,
      time: 0,
      color: "var(--muted)",
      bg: "var(--border)",
      note: "(cold starts)",
    },
  ];

  return (
    <div className="bar-chart">
      <h3 style={{ marginBottom: 20 }}>
        Pre-render time at deploy
      </h3>
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <div className="bar-label">
            {row.label}
            {row.note && (
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                {row.note}
              </div>
            )}
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${Math.max((row.time / maxTime) * 100, row.time > 0 ? 2 : 0)}%`,
                background: row.color,
              }}
            >
              {row.pages > 0 ? `${row.pages} pages` : ""}
            </div>
          </div>
          <div className="bar-value">
            {row.time > 0 ? formatDuration(row.time) : "0s"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── First-request latency comparison ────────────────────────

function LatencyComparison({ tprCoverage }: { tprCoverage: number }) {
  // For popular pages (within coverage threshold):
  //   SSG = 0ms (pre-rendered), ISR = 0ms (pre-rendered), TPR = 0ms (pre-rendered), SSR = ~200ms
  // For rare pages (outside coverage):
  //   SSG = 0ms, ISR = 0ms, TPR = ~200ms (SSR fallback), SSR = ~200ms
  // Weighted average based on coverage:
  const ssrLatency = 200;

  const rows = [
    {
      label: "SSR only",
      desc: "Every page, every time",
      p50: ssrLatency,
      color: "var(--muted)",
    },
    {
      label: "SSG / ISR",
      desc: "All pages pre-rendered",
      p50: 0,
      color: "var(--blue)",
    },
    {
      label: "TPR",
      desc: `${Math.round(tprCoverage)}% of visitors hit cache`,
      p50: Math.round(ssrLatency * (1 - tprCoverage / 100)),
      color: "var(--green)",
    },
  ];

  const maxLatency = ssrLatency;

  return (
    <div className="bar-chart" style={{ marginTop: 40 }}>
      <h3 style={{ marginBottom: 20 }}>
        Average first-request latency
      </h3>
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <div className="bar-label">
            {row.label}
            <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
              {row.desc}
            </div>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${Math.max((row.p50 / maxLatency) * 100, row.p50 > 0 ? 3 : 0)}%`,
                background: row.color,
              }}
            >
              {row.p50 > 0 ? `~${row.p50}ms` : ""}
            </div>
          </div>
          <div className="bar-value">
            {row.p50 > 0 ? `~${row.p50}ms` : "~0ms"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Visualization Component ────────────────────────────

export default function TPRVisualization() {
  const [coveragePct, setCoveragePct] = useState(90);

  const coverage = useMemo(
    () => calculateCoverage(traffic, coveragePct),
    [coveragePct],
  );

  return (
    <>
      {/* ── The Problem ────────────────────────────────────── */}
      <section>
        <div className="container">
          <h2 id="trade-off">The trade-off</h2>
          <p className="muted">
            Every framework makes you choose between fast builds and fast pages.
            None of these are optimal.
          </p>

          <div className="approaches">
            <div className="card">
              <div className="label" style={{ color: "var(--red)" }}>
                SSG
              </div>
              <div className="value">{estimateBuildTime(TOTAL_PAGES)}</div>
              <div className="desc">
                Pre-render all {TOTAL_PAGES} pages at build time.
                Fast for visitors, but builds scale linearly with page count.
                99% of those pages never get a request.
              </div>
            </div>

            <div className="card">
              <div className="label" style={{ color: "var(--muted)" }}>
                SSR
              </div>
              <div className="value">0s</div>
              <div className="desc">
                Render on every request. Zero build cost, but every visitor
                pays ~200ms of server render time. Popular pages re-rendered
                thousands of times for the same result.
              </div>
            </div>

            <div className="card highlight">
              <div className="label" style={{ color: "var(--accent)" }}>
                TPR
              </div>
              <div className="value">
                {estimateBuildTime(coverage.pagesNeeded)}
              </div>
              <div className="desc">
                Pre-render only the {coverage.pagesNeeded} pages that cover{" "}
                {Math.round(coverage.coveragePercent)}% of traffic.
                Popular pages are instant. Everything else falls back to SSR
                and gets cached.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Interactive Power Law Chart ────────────────────── */}
      <section>
        <div className="container">
          <h2 id="power-law">The power law</h2>
          <p className="muted">
            Web traffic follows a power law distribution. A tiny fraction
            of pages receive the vast majority of requests. TPR exploits this.
          </p>

          <div className="chart-container">
            <div className="chart-header">
              <div>
                <strong>{traffic.length.toLocaleString()}</strong>
                <span className="muted"> total pages</span>
              </div>
              <div>
                <strong style={{ color: "var(--green)" }}>
                  {coverage.pagesNeeded}
                </strong>
                <span className="muted"> pages cover </span>
                <strong style={{ color: "var(--green)" }}>
                  {Math.round(coverage.coveragePercent)}%
                </strong>
                <span className="muted"> of traffic</span>
              </div>
            </div>

            <TrafficChart data={traffic} coverage={coverage} />

            <div className="slider-row">
              <label>Coverage target</label>
              <input
                type="range"
                min={50}
                max={99}
                value={coveragePct}
                onChange={(e) => setCoveragePct(Number(e.target.value))}
              />
              <div className="slider-value">{coveragePct}%</div>
            </div>

            <div className="stats">
              <div className="stat">
                <div className="stat-label">Pages to pre-render</div>
                <div className="stat-value">{coverage.pagesNeeded}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Pre-render time</div>
                <div className="stat-value">
                  {estimateBuildTime(coverage.pagesNeeded)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Visitors served from cache</div>
                <div className="stat-value" style={{ color: "var(--green)" }}>
                  {Math.round(coverage.coveragePercent)}%
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">
                  Pages skipped vs SSG
                </div>
                <div className="stat-value" style={{ color: "var(--accent)" }}>
                  {TOTAL_PAGES - coverage.pagesNeeded}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Comparison ─────────────────────────────────────── */}
      <section>
        <div className="container">
          <h2 id="comparison">Head to head</h2>
          <p className="muted">
            TPR gives you SSG-level performance for the pages that matter,
            with SSR-level build times.
          </p>
          <ComparisonBars
            tprPages={coverage.pagesNeeded}
            totalPages={TOTAL_PAGES}
          />
          <LatencyComparison tprCoverage={coverage.coveragePercent} />
        </div>
      </section>

      {/* ── How It Works ───────────────────────────────────── */}
      <section>
        <div className="container">
          <h2>How it works</h2>
          <p className="muted">
            TPR adds one step to your deploy. No runtime changes needed.
          </p>

          <div className="steps">
            <div className="step">
              <div className="step-num">01</div>
              <div className="step-title">Query analytics</div>
              <div className="step-desc">
                Fetch top pages from Cloudflare zone analytics
                (GraphQL API, last 24h)
              </div>
            </div>
            <div className="step">
              <div className="step-num">02</div>
              <div className="step-title">Rank by traffic</div>
              <div className="step-desc">
                Sort pages by request count, accumulate until{" "}
                {coveragePct}% of traffic is covered
              </div>
            </div>
            <div className="step">
              <div className="step-num">03</div>
              <div className="step-title">Pre-render</div>
              <div className="step-desc">
                Spin up the built app locally, fetch each hot route to
                produce HTML
              </div>
            </div>
            <div className="step">
              <div className="step-num">04</div>
              <div className="step-title">Upload to KV</div>
              <div className="step-desc">
                Write pre-rendered pages to KV cache in the same format
                ISR uses at runtime
              </div>
            </div>
            <div className="step">
              <div className="step-num">05</div>
              <div className="step-title">Deploy</div>
              <div className="step-desc">
                Run wrangler deploy as normal. Popular pages are
                instantly warm.
              </div>
            </div>
          </div>

          <div className="code-block">
            <span className="dimmed">$ </span>
            <span className="highlight">vinext deploy --experimental-tpr</span>
            {"\n\n"}
            <span className="dimmed">{"  "}Project: tpr-demo</span>
            {"\n"}
            <span className="dimmed">{"  "}Router:{"  "}App Router</span>
            {"\n"}
            <span className="dimmed">{"  "}ISR:{"     "}detected</span>
            {"\n\n"}
            <span className="dimmed">{"  "}Building...</span>
            {"\n"}
            <span className="dimmed">{"  "}Build complete (4.2s)</span>
            {"\n\n"}
            <span className="green">
              {"  "}TPR: Analyzing traffic for tpr-demo.example.com (last 24h)
            </span>
            {"\n"}
            <span className="green">
              {"  "}TPR: {traffic.length.toLocaleString()} unique paths —{" "}
              {coverage.pagesNeeded} pages cover{" "}
              {Math.round(coverage.coveragePercent)}% of traffic
            </span>
            {"\n"}
            <span className="green">
              {"  "}TPR: Pre-rendering {coverage.pagesNeeded} pages...
            </span>
            {"\n"}
            <span className="green">
              {"  "}TPR: Pre-rendered {coverage.pagesNeeded} pages in{" "}
              {estimateBuildTime(coverage.pagesNeeded)} → KV cache
            </span>
            {"\n\n"}
            <span className="blue">{"  "}Deploying to Cloudflare Workers...</span>
            {"\n"}
            <span className="blue">
              {"  "}Deployed to: https://tpr-demo.example.com
            </span>
          </div>
        </div>
      </section>

      {/* ── This site ──────────────────────────────────────── */}
      <section>
        <div className="container">
          <h2>This demo site</h2>
          <p className="muted">
            This app has {TOTAL_PAGES} pages. Browse some products to see
            them in action — each has{" "}
            <code style={{ color: "var(--accent)", fontSize: "0.85em" }}>
              revalidate = 3600
            </code>{" "}
            for ISR.
          </p>

          <div className="stats" style={{ marginTop: 24 }}>
            <div className="stat">
              <div className="stat-label">Total pages</div>
              <div className="stat-value">{TOTAL_PAGES}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Product pages</div>
              <div className="stat-value">500</div>
            </div>
            <div className="stat">
              <div className="stat-label">SSG would render</div>
              <div className="stat-value" style={{ color: "var(--red)" }}>
                {TOTAL_PAGES}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">TPR renders</div>
              <div className="stat-value" style={{ color: "var(--green)" }}>
                {coverage.pagesNeeded}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 32 }}>
            <h3 style={{ marginBottom: 12 }}>
              Top pre-rendered pages
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 8,
              }}
            >
              {coverage.selectedPages.slice(0, 12).map((page) => (
                <a
                  key={page.path}
                  href={page.path}
                  style={{
                    display: "block",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "12px 16px",
                    color: "var(--fg)",
                    textDecoration: "none",
                    fontSize: "0.85rem",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {page.label}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "0.75rem",
                      color: "var(--muted)",
                      marginTop: 4,
                    }}
                  >
                    {formatNum(page.requests)} requests
                    <span style={{ margin: "0 6px", opacity: 0.3 }}>|</span>
                    {page.path}
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
