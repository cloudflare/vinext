import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recentMedianMeasurements } from "../apps/web/app/benchmarks/components/recent-median-measurements";
import type {
  PerformanceMeasurement,
  PerformanceRun,
} from "../apps/web/app/benchmarks/components/performance-results";
import { PerformanceResultsTable } from "../apps/web/app/benchmarks/components/performance-results";

function measurement(benchmarkId: string, median: number, unit = "bytes"): PerformanceMeasurement {
  return {
    benchmarkId,
    scenarioId: benchmarkId,
    suite: "Build",
    label: benchmarkId,
    description: benchmarkId,
    implementationId: "vinext",
    implementationLabel: "vinext",
    unit,
    lowerIsBetter: true,
    median,
    mean: median,
    standardDeviation: 0,
    rounds: 1,
    min: median,
    max: median,
  };
}

function run(id: string, measurements: PerformanceMeasurement[]): PerformanceRun {
  return {
    id,
    commitSha: id.repeat(40),
    shortSha: id.repeat(7),
    measuredAt: "2026-06-21T00:00:00.000Z",
    measurements,
  };
}

describe("performance dashboard rolling baseline", () => {
  it("uses the median of each benchmark's available historical measurements", () => {
    const current = [measurement("rsc", 130), measurement("server", 220)];
    const baseline = recentMedianMeasurements(current, [
      run("a", [measurement("rsc", 100)]),
      run("b", [measurement("rsc", 120), measurement("server", 200)]),
      run("c", [measurement("rsc", 110), measurement("server", 180)]),
    ]);

    expect(baseline.map(({ benchmarkId, median }) => [benchmarkId, median])).toEqual([
      ["rsc", 110],
      ["server", 190],
    ]);
  });

  it("omits benchmarks with no historical measurement", () => {
    const baseline = recentMedianMeasurements(
      [measurement("new-metric", 100)],
      [run("a", [measurement("other-metric", 90)])],
    );

    expect(baseline).toEqual([]);
  });

  it("can calculate the bundle baseline independently from timing benchmarks", () => {
    const current = [measurement("server", 220), measurement("build", 500, "ms")];
    const bundles = current.filter((candidate) => candidate.unit === "bytes");
    const baseline = recentMedianMeasurements(bundles, [
      run("a", [measurement("server", 200), measurement("build", 450, "ms")]),
    ]);

    expect(baseline.map(({ benchmarkId, median }) => [benchmarkId, median])).toEqual([
      ["server", 200],
    ]);
  });

  it("keeps a row-spanned scenario in one hover group", () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceResultsTable, {
        measurements: [
          {
            ...measurement("nextjs-cold-start", 300, "ms"),
            scenarioId: "cold-start",
            label: "Cold start",
            implementationId: "nextjs",
            implementationLabel: "Next.js",
          },
          {
            ...measurement("vinext-cold-start", 600, "ms"),
            scenarioId: "cold-start",
            label: "Cold start",
          },
          {
            ...measurement("vinext-bundle", 1_000),
            scenarioId: "bundle-size",
            label: "Bundle size",
          },
        ],
      }),
    );

    const spannedScenarioRow = html.match(
      /<tbody class="group\/scenario[^"]*"><tr class="([^"]*)"><td[^>]*rowSpan="2"/,
    );

    expect(spannedScenarioRow).not.toBeNull();
    expect(html.match(/<tbody/g)).toHaveLength(2);
    expect(html).toContain("group/scenario");
    expect(html).toContain("group-hover/scenario:bg-[var(--surface-2)]");
    expect(spannedScenarioRow?.[1]).not.toContain("hover:bg-[var(--surface-2)]");
  });
});
