"use client";

import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import {
  PerformanceResultsTable,
  PerformanceTrends,
  type PerformanceRun,
} from "./performance-results";

export function Dashboard({ runs }: { runs: PerformanceRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-400">
        No benchmark data yet. Results will appear after the first merge to main.
      </div>
    );
  }

  const latest = runs[0];

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold">Latest Performance Results</h2>
          <a href={`/benchmarks/commit/${latest.commitSha}`}>
            <Badge variant="secondary">{latest.shortSha}</Badge>
          </a>
          <span className="text-xs text-gray-400">
            {new Date(latest.measuredAt).toLocaleDateString()}
          </span>
        </div>
        <PerformanceResultsTable measurements={latest.measurements} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Performance Trends</h2>
        <PerformanceTrends runs={[...runs].reverse()} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent Main Runs</h2>
        <PerformanceRunHistory runs={runs} />
      </section>
    </div>
  );
}

function PerformanceRunHistory({ runs }: { runs: PerformanceRun[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Commit</Table.Head>
            <Table.Head>Scenarios</Table.Head>
            <Table.Head>Measured</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {runs.map((run) => (
            <Table.Row key={run.id}>
              <Table.Cell className="font-mono text-xs">
                <a
                  href={`/benchmarks/commit/${run.commitSha}`}
                  className="text-blue-700 hover:underline"
                >
                  {run.shortSha}
                </a>
              </Table.Cell>
              <Table.Cell>
                {new Set(run.measurements.map((measurement) => measurement.scenarioId)).size} ·{" "}
                {run.measurements.length} measurements
              </Table.Cell>
              <Table.Cell className="text-xs text-gray-500">
                {new Date(run.measuredAt).toLocaleString()}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
