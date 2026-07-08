"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Table } from "@cloudflare/kumo/components/table";
import { TrendChart } from "./chart";
import { formatBytes, formatMs, RUNNER_COLORS } from "./format";
import { benchmarkSelectionUrl, resolveSelectedBenchmarkFromSearch } from "./benchmark-url-state";

export type PerformanceMeasurement = {
  benchmarkId: string;
  scenarioId: string;
  suite: string;
  label: string;
  description: string;
  implementationId: string;
  implementationLabel: string;
  unit: string;
  lowerIsBetter: boolean;
  median: number;
  mean: number;
  standardDeviation: number;
  rounds: number;
  min: number;
  max: number;
};

export type PerformanceRun = {
  id: string;
  commitSha: string;
  shortSha: string;
  measuredAt: string;
  measurements: PerformanceMeasurement[];
};

const PERFORMANCE_COLORS = ["#f6821f", "#2563eb", "#16a34a", "#9333ea", "#dc2626"];

export function PerformanceResultsTable({
  measurements,
  baselineMeasurements,
  baselineLabel = "Baseline",
  renderFrameworkLabel,
}: {
  measurements: PerformanceMeasurement[];
  baselineMeasurements?: PerformanceMeasurement[];
  baselineLabel?: string;
  renderFrameworkLabel?: (measurement: PerformanceMeasurement) => ReactNode;
}) {
  const comparisonMode = baselineMeasurements !== undefined;
  const baselineByBenchmark = new Map(
    baselineMeasurements?.map((measurement) => [measurement.benchmarkId, measurement]) ?? [],
  );
  const scenarioGroups = Array.from(
    measurements.reduce((groups, measurement) => {
      const group = groups.get(measurement.scenarioId) ?? [];
      group.push(measurement);
      groups.set(measurement.scenarioId, group);
      return groups;
    }, new Map<string, PerformanceMeasurement[]>()),
  )
    .map(
      ([scenarioId, group]) =>
        [
          scenarioId,
          group.toSorted((left, right) =>
            left.implementationLabel.localeCompare(right.implementationLabel),
          ),
        ] as const,
    )
    .toSorted(([, left], [, right]) => left[0].label.localeCompare(right[0].label));

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Scenario</Table.Head>
            <Table.Head>Framework</Table.Head>
            {comparisonMode && <Table.Head>{baselineLabel}</Table.Head>}
            <Table.Head>{comparisonMode ? "Current" : "Median"}</Table.Head>
            {comparisonMode && <Table.Head>Change</Table.Head>}
            <Table.Head>Range</Table.Head>
            <Table.Head>Rounds</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {scenarioGroups.flatMap(([, group], groupIndex) =>
            group.map((measurement, index) => {
              const baseline = baselineByBenchmark.get(measurement.benchmarkId);
              const smallestMedian = Math.min(...group.map((item) => item.median));
              const largestMedian = Math.max(...group.map((item) => item.median));
              const smallerBy =
                !comparisonMode &&
                largestMedian > smallestMedian &&
                measurement.median === smallestMedian
                  ? ((largestMedian - smallestMedian) / largestMedian) * 100
                  : null;
              const change = baseline
                ? ((measurement.median - baseline.median) / baseline.median) * 100
                : null;
              const improved =
                change !== null && (measurement.lowerIsBetter ? change <= 0 : change >= 0);
              const neutral = change !== null && Math.abs(change) < 1.5;
              return (
                <Table.Row key={measurement.benchmarkId}>
                  {index === 0 && (
                    <Table.Cell
                      rowSpan={group.length}
                      className={`align-middle font-medium ${groupIndex === scenarioGroups.length - 1 ? "!border-b-0" : ""}`}
                    >
                      {measurement.label}
                    </Table.Cell>
                  )}
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: RUNNER_COLORS[measurement.implementationId] ?? "#6b7280",
                        }}
                      />
                      {renderFrameworkLabel?.(measurement) ?? (
                        <span className="font-medium">{measurement.implementationLabel}</span>
                      )}
                    </div>
                  </Table.Cell>
                  {comparisonMode && (
                    <Table.Cell className="font-mono text-sm">
                      {baseline ? formatPerformanceValue(baseline.median, measurement.unit) : "—"}
                    </Table.Cell>
                  )}
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">
                        {formatPerformanceValue(measurement.median, measurement.unit)}
                      </span>
                      {!comparisonMode && smallerBy !== null && (
                        <span
                          style={
                            {
                              "--framework-color":
                                RUNNER_COLORS[measurement.implementationId] ?? "#6b7280",
                            } as CSSProperties
                          }
                        >
                          <Badge
                            variant="primary"
                            className="!bg-[var(--framework-color)] !text-white font-semibold"
                          >
                            {smallerBy.toFixed(1)}% smaller
                          </Badge>
                        </span>
                      )}
                    </div>
                  </Table.Cell>
                  {comparisonMode && (
                    <Table.Cell>
                      {change === null ? (
                        <Badge variant="secondary">
                          {baselineMeasurements ? "Current only" : "New"}
                        </Badge>
                      ) : (
                        <Badge
                          variant={neutral ? "primary" : improved ? "green" : "destructive"}
                          className={
                            neutral ? "!bg-black !text-white font-semibold" : "font-semibold"
                          }
                        >
                          {change > 0 ? "+" : ""}
                          {change.toFixed(1)}%
                        </Badge>
                      )}
                    </Table.Cell>
                  )}
                  <Table.Cell className="text-xs text-gray-500">
                    {formatPerformanceValue(measurement.min, measurement.unit)}–
                    {formatPerformanceValue(measurement.max, measurement.unit)}
                  </Table.Cell>
                  <Table.Cell>{measurement.rounds}</Table.Cell>
                </Table.Row>
              );
            }),
          )}
        </Table.Body>
      </Table>
    </div>
  );
}

export function PerformanceTrends({ runs }: { runs: PerformanceRun[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const latest = runs.at(-1);
  const scenarios = useMemo(
    () =>
      latest
        ? Array.from(
            new Map(
              latest.measurements.map((measurement) => [measurement.scenarioId, measurement]),
            ).values(),
          )
        : [],
    [latest],
  );
  const scenarioIds = useMemo(() => scenarios.map((scenario) => scenario.scenarioId), [scenarios]);
  const [activeScenario, setActiveScenario] = useState(scenarioIds[0] ?? "");

  useEffect(() => {
    const selected = resolveSelectedBenchmarkFromSearch(scenarioIds, window.location.search);
    if (selected) setActiveScenario(selected);
  }, [scenarioIds, searchParams]);

  const selectedScenario =
    scenarios.find((scenario) => scenario.scenarioId === activeScenario) ?? scenarios[0];

  if (!selectedScenario) return null;

  return (
    <>
      <Tabs
        variant="segmented"
        tabs={scenarios.map((scenario) => ({
          value: scenario.scenarioId,
          label: scenario.label,
        }))}
        value={selectedScenario.scenarioId}
        onValueChange={(benchmarkId) => {
          setActiveScenario(benchmarkId);
          router.replace(
            benchmarkSelectionUrl(
              pathname,
              new URLSearchParams(window.location.search),
              benchmarkId,
              window.location.hash,
            ),
            { scroll: false },
          );
        }}
      />
      <div className="mt-4">
        <PerformanceTrendChart runs={runs} scenario={selectedScenario} />
      </div>
    </>
  );
}

function PerformanceTrendChart({
  runs,
  scenario,
}: {
  runs: PerformanceRun[];
  scenario: PerformanceMeasurement;
}) {
  const implementations = Array.from(
    new Map(
      runs
        .flatMap((run) => run.measurements)
        .filter((measurement) => measurement.scenarioId === scenario.scenarioId)
        .map((measurement) => [measurement.implementationId, measurement.implementationLabel]),
    ),
  );
  const series = implementations.map(([implementationId, implementationLabel], index) => ({
    name: implementationLabel,
    color: RUNNER_COLORS[implementationId] ?? PERFORMANCE_COLORS[index % PERFORMANCE_COLORS.length],
    values: runs.map(
      (run) =>
        run.measurements.find(
          (measurement) =>
            measurement.scenarioId === scenario.scenarioId &&
            measurement.implementationId === implementationId,
        )?.median ?? null,
    ),
  }));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-1 font-medium">{scenario.label}</div>
      <div className="mb-4 text-xs text-gray-400">
        {scenario.suite} · {scenario.lowerIsBetter ? "Lower is better" : "Higher is better"}
      </div>
      <TrendChart
        key={scenario.scenarioId}
        labels={runs.map((run) => run.shortSha)}
        pointKeys={runs.map((run) => run.id)}
        pointHrefs={runs.map((run) => `/benchmarks/commit/${run.commitSha}`)}
        series={series}
        yLabel={scenario.unit}
        formatY={(value) => formatPerformanceValue(value, scenario.unit)}
        height={300}
      />
    </div>
  );
}

function formatPerformanceValue(value: number, unit: string) {
  if (unit === "ms") return formatMs(value);
  if (unit === "bytes") return formatBytes(value);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}
