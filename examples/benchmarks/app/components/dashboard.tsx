"use client";

import { useState, useEffect } from "react";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import { TrendChart } from "./chart";
import {
  formatMs,
  formatBytes,
  speedup,
  sizeReduction,
  isImprovement,
  RUNNER_LABELS,
  RUNNER_COLORS,
} from "./format";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RunnerMetrics {
  buildTimeMean: number | null;
  buildTimeStddev: number | null;
  bundleSizeRaw: number | null;
  bundleSizeGzip: number | null;
  bundleFileCount: number | null;
  devColdStartMs: number | null;
  devPeakRssKb: number | null;
}

interface BenchmarkCommit {
  commitSha: string;
  commitShort: string;
  commitMessage: string;
  commitDate: string;
  runDate: string;
  runners: Record<string, RunnerMetrics>;
}

type MetricTab = "build_time" | "bundle_size" | "cold_start";

// ─── Dashboard Component ─────────────────────────────────────────────────────

export function Dashboard() {
  const [data, setData] = useState<BenchmarkCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MetricTab>("build_time");

  useEffect(() => {
    fetch("/api/results?limit=50")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading benchmark data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Failed to load benchmarks: {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-400">
        No benchmark data yet. Results will appear after the first merge to main.
      </div>
    );
  }

  const latest = data[0];
  // Reverse for chronological order in charts
  const chronological = [...data].reverse();

  return (
    <div className="space-y-8">
      {/* Latest results comparison table */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold">Latest Results</h2>
          <a href={`/commit/${latest.commitShort}`}>
            <Badge variant="secondary">{latest.commitShort}</Badge>
          </a>
          <span className="text-xs text-gray-400">
            {new Date(latest.commitDate).toLocaleDateString()}
          </span>
        </div>
        <LatestResultsTable commit={latest} />
      </section>

      {/* Trend charts */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Trends</h2>
        <Tabs
          variant="segmented"
          tabs={[
            { value: "build_time", label: "Build Time" },
            { value: "bundle_size", label: "Client Bundle Size" },
            { value: "cold_start", label: "Dev Cold Start" },
          ]}
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as MetricTab)}
        />
        <div className="mt-4">
          <MetricChart data={chronological} metric={activeTab} />
        </div>
      </section>

      {/* Recent commits list */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent Commits</h2>
        <CommitList commits={data} />
      </section>
    </div>
  );
}

// ─── Latest Results Table ────────────────────────────────────────────────────

function LatestResultsTable({ commit }: { commit: BenchmarkCommit }) {
  const nextjs = commit.runners.nextjs;
  const runners = Object.entries(commit.runners);

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Framework</Table.Head>
            <Table.Head>Build Time</Table.Head>
            <Table.Head>Client Bundle Size (gzip)</Table.Head>
            <Table.Head>Dev Cold Start</Table.Head>
            <Table.Head>Peak RSS</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {runners.map(([key, metrics]) => (
            <Table.Row key={key}>
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: RUNNER_COLORS[key] }}
                  />
                  <span className="font-medium">{RUNNER_LABELS[key] || key}</span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <span>{formatMs(metrics.buildTimeMean)}</span>
                  {key !== "nextjs" && nextjs && (
                    <ComparisonBadge
                      label={speedup(nextjs.buildTimeMean, metrics.buildTimeMean)}
                    />
                  )}
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <span>{formatBytes(metrics.bundleSizeGzip)}</span>
                  {key !== "nextjs" && nextjs && (
                    <ComparisonBadge
                      label={sizeReduction(nextjs.bundleSizeGzip, metrics.bundleSizeGzip)}
                    />
                  )}
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <span>{formatMs(metrics.devColdStartMs)}</span>
                  {key !== "nextjs" && nextjs && (
                    <ComparisonBadge
                      label={speedup(nextjs.devColdStartMs, metrics.devColdStartMs)}
                    />
                  )}
                </div>
              </Table.Cell>
              <Table.Cell>
                {metrics.devPeakRssKb
                  ? `${Math.round(metrics.devPeakRssKb / 1024)} MB`
                  : "-"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

function ComparisonBadge({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <Badge variant={isImprovement(label) ? "primary" : "destructive"}>
      {label}
    </Badge>
  );
}

// ─── Metric Chart ────────────────────────────────────────────────────────────

function MetricChart({
  data,
  metric,
}: {
  data: BenchmarkCommit[];
  metric: MetricTab;
}) {
  const runners = Object.keys(RUNNER_LABELS);

  // Shared x-axis labels — one per commit, in chronological order
  const labels = data.map((commit) => commit.commitShort);

  // Each series has one value per commit; null when the runner has no data for that commit
  const series = runners.map((runner) => ({
    name: RUNNER_LABELS[runner] || runner,
    color: RUNNER_COLORS[runner],
    values: data.map((commit) => {
      const m = commit.runners[runner];
      if (!m) return null;
      if (metric === "build_time") return m.buildTimeMean;
      if (metric === "bundle_size") return m.bundleSizeGzip;
      if (metric === "cold_start") return m.devColdStartMs;
      return null;
    }),
  }));

  const yLabel =
    metric === "build_time"
      ? "ms"
      : metric === "bundle_size"
        ? "bytes"
        : "ms";

  const formatY =
    metric === "bundle_size"
      ? (v: number) => formatBytes(v)
      : (v: number) => formatMs(v);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <TrendChart labels={labels} series={series} yLabel={yLabel} formatY={formatY} height={300} />
    </div>
  );
}

// ─── Commit List ─────────────────────────────────────────────────────────────

function CommitList({ commits }: { commits: BenchmarkCommit[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Commit</Table.Head>
            <Table.Head>Date</Table.Head>
            <Table.Head>Build Time (vinext Rolldown)</Table.Head>
            <Table.Head>Client Bundle Size (vinext Rolldown)</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {commits.map((c) => {
            const rd = c.runners.vinext_rolldown;
            return (
              <Table.Row key={c.commitSha}>
                <Table.Cell>
                  <a
                    href={`/commit/${c.commitShort}`}
                    className="font-mono text-sm text-blue-600 hover:underline"
                  >
                    {c.commitShort}
                  </a>
                  <span className="ml-2 text-xs text-gray-400 truncate max-w-xs inline-block align-middle">
                    {c.commitMessage?.slice(0, 60)}
                  </span>
                </Table.Cell>
                <Table.Cell className="text-sm text-gray-500">
                  {new Date(c.commitDate).toLocaleDateString()}
                </Table.Cell>
                <Table.Cell>{rd ? formatMs(rd.buildTimeMean) : "-"}</Table.Cell>
                <Table.Cell>{rd ? formatBytes(rd.bundleSizeGzip) : "-"}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </div>
  );
}
