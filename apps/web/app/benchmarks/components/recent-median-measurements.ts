import type { PerformanceMeasurement, PerformanceRun } from "./performance-results";

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
