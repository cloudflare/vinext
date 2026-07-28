"use client";

import { Suspense } from "react";
import { Badge, Table } from "../../_components/ui";
import {
  PerformanceResultsTable,
  PerformanceTrends,
  type PerformanceRun,
} from "./performance-results";
import { CustomProfileViewer } from "./custom-profile-viewer";
import { formatUtcDate, formatUtcDateTime } from "./format";
import { recentMedianMeasurements } from "./recent-median-measurements";

const RECENT_BASELINE_RUNS = 10;

export function Dashboard({ runs }: { runs: PerformanceRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="space-y-8">
        <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-6 py-12 text-center text-[var(--mute)]">
          No benchmark data yet. Results will appear after the first merge to main.
        </div>
        <CustomProfileViewer />
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
          <span className="text-xs whitespace-nowrap text-[var(--mute)]">
            {formatUtcDate(latest.measuredAt)}
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
                  <span className="text-xs text-[var(--sub)]">
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
            <div className="h-[374px] animate-pulse rounded-lg border border-[var(--line)] bg-[var(--surface-2)]" />
          }
        >
          <PerformanceTrends runs={[...runs].reverse()} />
        </Suspense>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent Main Runs</h2>
        <PerformanceRunHistory runs={runs} />
      </section>

      <CustomProfileViewer />
    </div>
  );
}

function PerformanceRunHistory({ runs }: { runs: PerformanceRun[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--surface)]">
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
                  className="text-[var(--orange-soft)] hover:underline"
                >
                  {run.shortSha}
                </a>
              </Table.Cell>
              <Table.Cell>
                {new Set(run.measurements.map((measurement) => measurement.scenarioId)).size} ·{" "}
                {run.measurements.length} measurements
              </Table.Cell>
              <Table.Cell className="text-xs text-[var(--sub)]">
                {formatUtcDateTime(run.measuredAt)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
