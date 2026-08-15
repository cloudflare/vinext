import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getPullComparison, uploadPerformanceRun } from "../apps/web/app/lib/benchmarks/server";

const cloudflareEnv = vi.hoisted<{ DB: unknown; PERFORMANCE_PROFILES: unknown }>(() => ({
  DB: null,
  PERFORMANCE_PROFILES: {
    delete: vi.fn(),
  },
}));
let claimExecution: boolean;

vi.mock("cloudflare:workers", () => ({ env: cloudflareEnv }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

class MockStatement {
  values: unknown[] = [];

  constructor(readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first() {
    return null;
  }

  async all() {
    return { results: [] };
  }

  async run() {
    return { success: true };
  }
}

describe("performance dashboard uploads", () => {
  let batchedStatements: MockStatement[];

  beforeEach(() => {
    batchedStatements = [];
    claimExecution = true;
    cloudflareEnv.DB = {
      prepare: (sql: string) => new MockStatement(sql),
      batch: async (statements: MockStatement[]) => {
        batchedStatements = statements;
        return statements.map((_, index) => ({
          results: index === 0 && claimExecution ? [{}] : [],
        }));
      },
    };
  });

  it("persists paired baseline statistics with the head measurement", async () => {
    const baselineSamples = {
      rounds: 6,
      mean: 100,
      median: 101,
      standardDeviation: 2,
      min: 97,
      max: 104,
      q1: 99,
      q3: 102,
      outliers: 0,
    };
    const response = await uploadPerformanceRun(
      new Request("https://vinext.dev/api/benchmarks/upload", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 2,
          provider: "samply",
          instrument: "walltime",
          run: {
            kind: "pull_request",
            commitSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            pullRequest: 42,
            executionId: "1:1",
            measuredAt: "2026-06-18T12:00:00.000Z",
            repository: "cloudflare/vinext",
          },
          system: {},
          benchmarks: [
            {
              benchmarkId: "vinext-production-build",
              scenarioId: "production-build",
              suite: "Build",
              label: "Production build time",
              description: "Build the benchmark application",
              implementationId: "vinext",
              implementationLabel: "vinext",
              unit: "ms",
              lowerIsBetter: true,
              samples: {
                rounds: 6,
                mean: 90,
                median: 91,
                standardDeviation: 1,
                min: 88,
                max: 93,
                q1: 90,
                q3: 92,
                outliers: 0,
              },
              baselineSamples,
              profileRounds: 1,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(201);
    const measurementInsert = batchedStatements.find((statement) =>
      statement.sql.includes("INSERT INTO performance_measurements"),
    );
    expect(measurementInsert?.values.slice(19, 28)).toEqual(Object.values(baselineSamples));
    expect(measurementInsert?.values[29]).toBe(1);
  });

  it("rejects schema 2 payloads without paired baseline statistics", async () => {
    const response = await uploadPerformanceRun(
      new Request("https://vinext.dev/api/benchmarks/upload", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 2,
          provider: "samply",
          instrument: "walltime",
          run: {
            kind: "pull_request",
            commitSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            pullRequest: 42,
            executionId: "1:1",
            measuredAt: "2026-06-18T12:00:00.000Z",
            repository: "cloudflare/vinext",
          },
          system: {},
          benchmarks: [
            {
              benchmarkId: "vinext-production-build",
              scenarioId: "production-build",
              suite: "Build",
              label: "Production build time",
              description: "Build the benchmark application",
              implementationId: "vinext",
              implementationLabel: "vinext",
              unit: "ms",
              lowerIsBetter: true,
              samples: {
                rounds: 6,
                mean: 90,
                median: 91,
                standardDeviation: 1,
                min: 88,
                max: 93,
                q1: 90,
                q3: 92,
                outliers: 0,
              },
              baselineSamples: null,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Performance schema 2 requires paired baseline samples",
    });
    expect(batchedStatements).toEqual([]);
  });

  it("rejects schema 2 payloads that omit paired baseline statistics", async () => {
    const response = await uploadPerformanceRun(
      new Request("https://vinext.dev/api/benchmarks/upload", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 2,
          provider: "samply",
          instrument: "walltime",
          run: {
            kind: "pull_request",
            commitSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            pullRequest: 42,
            executionId: "1:1",
            measuredAt: "2026-06-18T12:00:00.000Z",
            repository: "cloudflare/vinext",
          },
          system: {},
          benchmarks: [
            {
              benchmarkId: "vinext-production-build",
              scenarioId: "production-build",
              suite: "Build",
              label: "Production build time",
              description: "Build the benchmark application",
              implementationId: "vinext",
              implementationLabel: "vinext",
              unit: "ms",
              lowerIsBetter: true,
              samples: {
                rounds: 6,
                mean: 90,
                median: 91,
                standardDeviation: 1,
                min: 88,
                max: 93,
                q1: 90,
                q3: 92,
                outliers: 0,
              },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Performance schema 2 requires paired baseline samples",
    });
    expect(batchedStatements).toEqual([]);
  });

  it("rejects delayed executions older than the stored run", async () => {
    claimExecution = false;
    const response = await uploadPerformanceRun(
      new Request("https://vinext.dev/api/benchmarks/upload", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          provider: "samply",
          instrument: "walltime",
          run: {
            kind: "pull_request",
            commitSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            pullRequest: 42,
            executionId: "199:3",
            measuredAt: "2026-06-18T12:00:00.000Z",
            repository: "cloudflare/vinext",
          },
          system: {},
          benchmarks: [
            {
              benchmarkId: "vinext-production-build",
              scenarioId: "production-build",
              suite: "Build",
              label: "Production build time",
              description: "Build the benchmark application",
              implementationId: "vinext",
              implementationLabel: "vinext",
              unit: "ms",
              lowerIsBetter: true,
              samples: {
                rounds: 5,
                mean: 90,
                median: 91,
                standardDeviation: 1,
                min: 88,
                max: 93,
                q1: 90,
                q3: 92,
                outliers: 0,
              },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Stale performance execution" });
    expect(batchedStatements[0]?.sql).toContain("ON CONFLICT(id) DO UPDATE");
    expect(batchedStatements[1]?.sql).toContain("WHERE run_id = ?");
    expect(batchedStatements[2]?.sql).toContain("WHERE EXISTS");
  });

  it("uses historical baselines for unpaired rows in mixed PR runs", async () => {
    const pullRun = {
      id: "pull:a",
      kind: "pull_request",
      commit_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      pull_request: 42,
      measured_at: "2026-06-18T12:00:00.000Z",
    };
    const baselineRun = {
      id: "main:b",
      kind: "main",
      commit_sha: "b".repeat(40),
      measured_at: "2026-06-17T12:00:00.000Z",
    };
    const currentRows = [measurementRow("paired", 90, 100), measurementRow("unpaired", 80, null)];
    const baselineRows = [
      measurementRow("paired", 120, null),
      measurementRow("unpaired", 100, null),
    ];

    cloudflareEnv.DB = {
      prepare: (sql: string) => ({
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("kind = 'pull_request'")) return pullRun;
          if (sql.includes("kind = 'main'")) return baselineRun;
          if (sql.includes("paired_baseline_rounds IS NOT NULL")) return { present: 1 };
          return null;
        },
        async all() {
          if (!sql.includes("FROM performance_measurements")) return { results: [] };
          return { results: this.values[0] === pullRun.id ? currentRows : baselineRows };
        },
      }),
    };

    const comparison = await getPullComparison("42");

    expect(
      comparison?.measurements.find((row) => row.benchmarkId === "paired")?.baseline,
    ).toMatchObject({
      median: 100,
    });
    expect(
      comparison?.measurements.find((row) => row.benchmarkId === "paired")?.baselineSource,
    ).toBe("paired");
    expect(
      comparison?.measurements.find((row) => row.benchmarkId === "unpaired")?.baseline,
    ).toMatchObject({ median: 100 });
    expect(
      comparison?.measurements.find((row) => row.benchmarkId === "unpaired")?.baselineSource,
    ).toBe("historical");
    expect(comparison?.description).toContain(
      "Paired rows use same-runner base measurements; unpaired rows use a historical run",
    );
    expect(comparison?.baselineLabel).toBe("Mixed baselines");
    expect(comparison?.baseline?.measuredAt).toBeNull();
  });

  it("does not label a paired baseline with the head commit date", async () => {
    const pullRun = {
      id: "pull:a",
      kind: "pull_request",
      commit_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      pull_request: 42,
      measured_at: "2026-06-18T12:00:00.000Z",
    };
    const currentRows = [measurementRow("paired", 90, 100)];

    cloudflareEnv.DB = {
      prepare: (sql: string) => ({
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("kind = 'pull_request'")) return pullRun;
          return null;
        },
        async all() {
          if (!sql.includes("FROM performance_measurements")) return { results: [] };
          return { results: this.values[0] === pullRun.id ? currentRows : [] };
        },
      }),
    };

    const comparison = await getPullComparison("42");

    expect(comparison?.baseline).toEqual({
      sha: "b".repeat(40),
      shortSha: "b".repeat(7),
      measuredAt: null,
    });
  });
});

function measurementRow(benchmarkId: string, median: number, pairedBaselineMedian: number | null) {
  return {
    benchmark_id: benchmarkId,
    scenario_id: benchmarkId,
    suite: "Build",
    label: benchmarkId,
    description: "",
    implementation_id: benchmarkId,
    implementation_label: benchmarkId,
    unit: "ms",
    lower_is_better: 1,
    rounds: 6,
    mean_value: median,
    median_value: median,
    standard_deviation_value: 0,
    min_value: median,
    max_value: median,
    paired_baseline_rounds: pairedBaselineMedian === null ? null : 6,
    paired_baseline_mean_value: pairedBaselineMedian,
    paired_baseline_median_value: pairedBaselineMedian,
    paired_baseline_standard_deviation_value: pairedBaselineMedian === null ? null : 0,
    paired_baseline_min_value: pairedBaselineMedian,
    paired_baseline_max_value: pairedBaselineMedian,
    flame_graph_json: null,
    profile_rounds: null,
    profile_object_key: null,
  };
}
