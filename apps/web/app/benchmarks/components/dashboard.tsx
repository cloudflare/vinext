"use client";

import { Suspense } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import {
  PerformanceResultsTable,
  PerformanceTrends,
  type PerformanceMeasurement,
  type PerformanceRun,
} from "./performance-results";

const RECENT_BASELINE_RUNS = 10;

export function Dashboard({ runs }: { runs: PerformanceRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-400">
        No benchmark data yet. Results will appear after the first merge to main.
      </div>
    );
  }

  const latest = runs[0];
  const baselineRuns = runs.slice(1, RECENT_BASELINE_RUNS + 1);
  const bundleMeasurements = latest.measurements.filter(
    (measurement) => measurement.unit === "bytes",
  );
  const otherMeasurements = latest.measurements.filter(
    (measurement) => measurement.unit !== "bytes",
  );
  const baselineMeasurements = recentMedianMeasurements(bundleMeasurements, baselineRuns);

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
        <div className="space-y-5">
          {otherMeasurements.length > 0 && (
            <PerformanceResultsTable measurements={otherMeasurements} />
          )}
          {bundleMeasurements.length > 0 && (
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="font-medium">Bundle sizes</h3>
                {baselineRuns.length > 0 && (
                  <span className="text-xs text-gray-500">
                    vs prior {baselineRuns.length}-run median
                  </span>
                )}
              </div>
              <PerformanceResultsTable
                measurements={bundleMeasurements}
                baselineMeasurements={baselineRuns.length > 0 ? baselineMeasurements : undefined}
                baselineLabel={`Prior ${baselineRuns.length}-run median`}
              />
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Performance Trends</h2>
        <Suspense
          fallback={
            <div className="h-[374px] animate-pulse rounded-lg border border-gray-200 bg-gray-50" />
          }
        >
          <PerformanceTrends runs={[...runs].reverse()} />
        </Suspense>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent Main Runs</h2>
        <PerformanceRunHistory runs={runs} />
      </section>
    </div>
  );
}

export function recentMedianMeasurements(
  currentMeasurements: PerformanceMeasurement[],
  baselineRuns: PerformanceRun[],
): PerformanceMeasurement[] {
  return currentMeasurements.flatMap((current) => {
    const historical = baselineRuns.flatMap((run) => {
      const measurement = run.measurements.find(
        (candidate) => candidate.benchmarkId === current.benchmarkId,
      );
      return measurement ? [measurement] : [];
    });
    if (historical.length === 0) return [];

    return [
      {
        ...current,
        median: median(historical.map((measurement) => measurement.median)),
      },
    ];
  });
}

function median(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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
