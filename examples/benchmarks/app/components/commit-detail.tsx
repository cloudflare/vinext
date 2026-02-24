"use client";

import { useState, useEffect } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import {
  formatMs,
  formatBytes,
  speedup,
  sizeReduction,
  isImprovement,
  RUNNER_LABELS,
} from "./format";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RunnerResult {
  runner: string;
  build_time_mean: number | null;
  build_time_stddev: number | null;
  build_time_min: number | null;
  build_time_max: number | null;
  bundle_size_raw: number | null;
  bundle_size_gzip: number | null;
  bundle_file_count: number | null;
  dev_cold_start_ms: number | null;
  dev_peak_rss_kb: number | null;
  platform: string | null;
  arch: string | null;
  node_version: string | null;
  cpu_count: number | null;
  run_count: number | null;
  commit_message: string;
  commit_date: string;
  run_date: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CommitDetail({ sha }: { sha: string }) {
  const [data, setData] = useState<RunnerResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/commit/${sha}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Commit not found" : `HTTP ${res.status}`);
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
  }, [sha]);

  if (loading) {
    return <div className="py-20 text-center text-gray-400">Loading...</div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (data.length === 0) {
    return <div className="py-12 text-center text-gray-400">No results for this commit.</div>;
  }

  const first = data[0];
  const nextjs = data.find((d) => d.runner === "nextjs");

  return (
    <div className="space-y-6">
      {/* Commit header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold font-mono">{sha}</h1>
          <Badge variant="secondary">
            {first.run_count} run{first.run_count !== 1 ? "s" : ""}
          </Badge>
        </div>
        {first.commit_message && (
          <p className="mt-1 text-sm text-gray-600">{first.commit_message}</p>
        )}
        <div className="mt-2 flex gap-4 text-xs text-gray-400">
          <span>Committed: {new Date(first.commit_date).toLocaleString()}</span>
          <span>Benchmarked: {new Date(first.run_date).toLocaleString()}</span>
          {first.platform && (
            <span>
              {first.platform}/{first.arch} &middot; Node {first.node_version} &middot;{" "}
              {first.cpu_count} CPUs
            </span>
          )}
        </div>
      </div>

      {/* Build Time */}
      <MetricSection title="Production Build Time">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Framework</Table.Head>
              <Table.Head>Mean</Table.Head>
              <Table.Head>StdDev</Table.Head>
              <Table.Head>Min</Table.Head>
              <Table.Head>Max</Table.Head>
              <Table.Head>vs Next.js</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((r) => (
              <Table.Row key={r.runner}>
                <Table.Cell className="font-medium">
                  {RUNNER_LABELS[r.runner] || r.runner}
                </Table.Cell>
                <Table.Cell>{formatMs(r.build_time_mean)}</Table.Cell>
                <Table.Cell className="text-gray-400">
                  {r.build_time_stddev !== null ? `\u00b1${formatMs(r.build_time_stddev)}` : "-"}
                </Table.Cell>
                <Table.Cell>{formatMs(r.build_time_min)}</Table.Cell>
                <Table.Cell>{formatMs(r.build_time_max)}</Table.Cell>
                <Table.Cell>
                  {r.runner === "nextjs" ? (
                    <span className="text-gray-400">baseline</span>
                  ) : (() => {
                    const label = speedup(nextjs?.build_time_mean ?? null, r.build_time_mean);
                    return label ? (
                      <Badge variant={isImprovement(label) ? "primary" : "destructive"}>
                        {label}
                      </Badge>
                    ) : "-";
                  })()}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </MetricSection>

      {/* Client Bundle Size */}
      <MetricSection title="Production Bundle Size (Client)">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Framework</Table.Head>
              <Table.Head>Files</Table.Head>
              <Table.Head>Raw</Table.Head>
              <Table.Head>Gzipped</Table.Head>
              <Table.Head>vs Next.js (gzip)</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((r) => (
              <Table.Row key={r.runner}>
                <Table.Cell className="font-medium">
                  {RUNNER_LABELS[r.runner] || r.runner}
                </Table.Cell>
                <Table.Cell>{r.bundle_file_count ?? "-"}</Table.Cell>
                <Table.Cell>{formatBytes(r.bundle_size_raw)}</Table.Cell>
                <Table.Cell>{formatBytes(r.bundle_size_gzip)}</Table.Cell>
                <Table.Cell>
                  {r.runner === "nextjs" ? (
                    <span className="text-gray-400">baseline</span>
                  ) : (() => {
                    const label = sizeReduction(nextjs?.bundle_size_gzip ?? null, r.bundle_size_gzip);
                    return label ? (
                      <Badge variant={isImprovement(label) ? "primary" : "destructive"}>
                        {label}
                      </Badge>
                    ) : "-";
                  })()}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </MetricSection>

      {/* Dev Cold Start */}
      <MetricSection title="Dev Server Cold Start">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Framework</Table.Head>
              <Table.Head>Mean Cold Start</Table.Head>
              <Table.Head>Peak RSS</Table.Head>
              <Table.Head>vs Next.js</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((r) => (
              <Table.Row key={r.runner}>
                <Table.Cell className="font-medium">
                  {RUNNER_LABELS[r.runner] || r.runner}
                </Table.Cell>
                <Table.Cell>{formatMs(r.dev_cold_start_ms)}</Table.Cell>
                <Table.Cell>
                  {r.dev_peak_rss_kb ? `${Math.round(r.dev_peak_rss_kb / 1024)} MB` : "-"}
                </Table.Cell>
                <Table.Cell>
                  {r.runner === "nextjs" ? (
                    <span className="text-gray-400">baseline</span>
                  ) : (() => {
                    const label = speedup(nextjs?.dev_cold_start_ms ?? null, r.dev_cold_start_ms);
                    return label ? (
                      <Badge variant={isImprovement(label) ? "primary" : "destructive"}>
                        {label}
                      </Badge>
                    ) : "-";
                  })()}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </MetricSection>
    </div>
  );
}

function MetricSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">{children}</div>
    </section>
  );
}
