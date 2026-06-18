import { env } from "cloudflare:workers";
import { revalidatePath } from "next/cache";

type CloudflareEnv = {
  DB: D1Database;
  PERFORMANCE_PROFILES: R2Bucket;
};

type NormalizedPerfPayload = {
  schemaVersion: 1;
  provider: "samply";
  instrument: "walltime";
  run: {
    kind: "main" | "pull_request";
    commitSha: string;
    baseSha: string | null;
    pullRequest: number | null;
    executionId: string;
    measuredAt: string;
    repository: string;
  };
  system: Record<string, unknown>;
  benchmarks: Array<{
    benchmarkId: string;
    scenarioId: string;
    suite: string;
    label: string;
    description: string;
    implementationId: string;
    implementationLabel: string;
    unit: string;
    lowerIsBetter: boolean;
    samples: {
      rounds: number;
      mean: number;
      median: number;
      standardDeviation: number;
      min: number;
      max: number;
      q1: number;
      q3: number;
      outliers: number;
    };
    profileObjectKey?: string;
  }>;
};

function getD1() {
  return (env as CloudflareEnv).DB;
}

function getProfilesBucket() {
  return (env as CloudflareEnv).PERFORMANCE_PROFILES;
}

export async function uploadPerformanceRun(request: Request): Promise<Response> {
  let body: NormalizedPerfPayload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.schemaVersion !== 1 ||
    body.provider !== "samply" ||
    body.instrument !== "walltime" ||
    !body.run?.commitSha ||
    !body.run.executionId ||
    !Array.isArray(body.benchmarks) ||
    body.benchmarks.some(
      (benchmark) =>
        !benchmark.benchmarkId ||
        !benchmark.scenarioId ||
        !benchmark.suite ||
        !benchmark.label ||
        !benchmark.implementationId ||
        !benchmark.implementationLabel ||
        !benchmark.unit,
    )
  ) {
    return Response.json({ error: "Invalid normalized performance payload" }, { status: 400 });
  }

  if (
    body.run.kind === "pull_request" &&
    (!body.run.baseSha ||
      body.run.pullRequest === null ||
      !Number.isInteger(body.run.pullRequest) ||
      body.run.pullRequest <= 0)
  ) {
    return Response.json(
      { error: "Pull request runs require baseSha and pullRequest" },
      { status: 400 },
    );
  }

  const db = getD1();
  const profiles = getProfilesBucket();
  const runId = `${body.run.kind}:${body.run.commitSha}`;
  const profileKeys = new Map(
    body.benchmarks.flatMap((benchmark) =>
      benchmark.profileObjectKey
        ? [[benchmark.benchmarkId, benchmark.profileObjectKey] as const]
        : [],
    ),
  );
  const expectedPrefix = `profiles/${body.run.kind}/${body.run.commitSha}/${encodeURIComponent(body.run.executionId)}/`;
  if ([...profileKeys.values()].some((key) => !key.startsWith(expectedPrefix))) {
    return Response.json({ error: "Invalid performance profile object key" }, { status: 400 });
  }
  const statements = [
    db
      .prepare(`
        DELETE FROM performance_measurements
        WHERE run_id IN (
          SELECT id FROM performance_runs WHERE kind = ? AND commit_sha = ?
        )
        RETURNING profile_object_key
      `)
      .bind(body.run.kind, body.run.commitSha),
    db
      .prepare("DELETE FROM performance_runs WHERE kind = ? AND commit_sha = ?")
      .bind(body.run.kind, body.run.commitSha),
    db
      .prepare(`
        INSERT INTO performance_runs (
          id, kind, commit_sha, base_sha, pull_request, measured_at,
          provider, instrument, repository, system_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        runId,
        body.run.kind,
        body.run.commitSha,
        body.run.baseSha,
        body.run.pullRequest,
        body.run.measuredAt,
        body.provider,
        body.instrument,
        body.run.repository,
        JSON.stringify(body.system),
      ),
    ...body.benchmarks.map((benchmark) =>
      db
        .prepare(`
          INSERT INTO performance_measurements (
            run_id, benchmark_id, scenario_id, suite, label, description,
            implementation_id, implementation_label, unit,
            lower_is_better, rounds, mean_value, median_value,
            standard_deviation_value, min_value, max_value, q1_value,
            q3_value, outliers, flame_graph_json, profile_object_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          runId,
          benchmark.benchmarkId,
          benchmark.scenarioId,
          benchmark.suite,
          benchmark.label,
          benchmark.description,
          benchmark.implementationId,
          benchmark.implementationLabel,
          benchmark.unit,
          benchmark.lowerIsBetter ? 1 : 0,
          benchmark.samples.rounds,
          benchmark.samples.mean,
          benchmark.samples.median,
          benchmark.samples.standardDeviation,
          benchmark.samples.min,
          benchmark.samples.max,
          benchmark.samples.q1,
          benchmark.samples.q3,
          benchmark.samples.outliers,
          null,
          profileKeys.get(benchmark.benchmarkId) ?? null,
        ),
    ),
  ];

  const [deletedMeasurements] = await db.batch(statements);
  const retainedKeys = new Set(profileKeys.values());
  const obsoleteKeys = (deletedMeasurements.results as Array<{ profile_object_key: string | null }>)
    .map((row) => row.profile_object_key)
    .filter((key): key is string => key !== null)
    .filter((key) => !retainedKeys.has(key));
  try {
    for (const key of obsoleteKeys) {
      const deleted = await db
        .prepare(
          "DELETE FROM performance_profile_objects WHERE object_key = ? RETURNING object_key",
        )
        .bind(key)
        .first<{ object_key: string }>();
      if (!deleted) continue;
      try {
        await profiles.delete(deleted.object_key);
      } catch (error) {
        await db
          .prepare("INSERT OR IGNORE INTO performance_profile_objects (object_key) VALUES (?)")
          .bind(deleted.object_key)
          .run();
        throw error;
      }
    }
  } catch (error) {
    console.error("Failed to delete obsolete performance profiles", error);
  }
  try {
    revalidatePath("/benchmarks");
    revalidatePath(`/benchmarks/commit/${body.run.commitSha}`);
    if (body.run.kind === "pull_request" && body.run.pullRequest !== null) {
      revalidatePath(`/benchmarks/pull/${body.run.pullRequest}`);
    } else if (body.run.kind === "main") {
      const { results: matchingPullRequests } = await db
        .prepare(`
          SELECT DISTINCT pull_request, commit_sha
          FROM performance_runs
          WHERE kind = 'pull_request' AND base_sha = ? AND pull_request IS NOT NULL
        `)
        .bind(body.run.commitSha)
        .all<{ pull_request: number; commit_sha: string }>();
      for (const run of matchingPullRequests) {
        revalidatePath(`/benchmarks/pull/${run.pull_request}`);
        revalidatePath(`/benchmarks/commit/${run.commit_sha}`);
      }
    }
  } catch (error) {
    console.error("Failed to revalidate performance pages", error);
  }
  let comparisonData = null;
  try {
    comparisonData =
      body.run.kind === "pull_request" && body.run.pullRequest !== null
        ? await getPullComparison(String(body.run.pullRequest))
        : null;
  } catch (error) {
    console.error("Failed to build performance comparison response", error);
  }
  const comparison = comparisonData
    ? {
        ...comparisonData,
        measurements: comparisonData.measurements.map(
          ({ flameGraph: _flameGraph, profileUrl: _profileUrl, ...measurement }) => measurement,
        ),
      }
    : null;
  return Response.json(
    { ok: true, runId, measurements: body.benchmarks.length, comparison },
    { status: 201 },
  );
}

type PerformanceMeasurementData = {
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

export type PerformanceRunData = {
  id: string;
  commitSha: string;
  shortSha: string;
  measuredAt: string;
  measurements: PerformanceMeasurementData[];
};

type PerformanceStatsData = {
  median: number;
  mean: number;
  standardDeviation: number;
  rounds: number;
  min: number;
  max: number;
};

export type FlameGraphData = {
  name: string;
  value: number;
  source?: string;
  category?: string;
  children?: FlameGraphData[];
};

type PerformanceComparisonMeasurementData = Omit<
  PerformanceMeasurementData,
  keyof PerformanceStatsData
> & {
  baseline: PerformanceStatsData | null;
  current: PerformanceStatsData;
  flameGraph: FlameGraphData | null;
  profileUrl: string | null;
};

export async function getPerformanceRuns(limit = 50): Promise<PerformanceRunData[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const db = getD1();
  const { results } = await db
    .prepare(`
      SELECT id, commit_sha, measured_at
      FROM performance_runs
      WHERE kind = 'main'
      ORDER BY measured_at DESC
      LIMIT ?
    `)
    .bind(boundedLimit)
    .all<Record<string, string>>();

  if (results.length === 0) return [];

  const placeholders = results.map(() => "?").join(", ");
  const measurements = await db
    .prepare(`
      SELECT * FROM performance_measurements
      WHERE run_id IN (${placeholders})
      ORDER BY run_id, suite, label, implementation_label
    `)
    .bind(...results.map((row) => row.id))
    .all<Record<string, unknown>>();
  const measurementsByRun = new Map<string, PerformanceMeasurementData[]>();

  for (const measurement of measurements.results) {
    const runId = String(measurement.run_id);
    const runMeasurements = measurementsByRun.get(runId) ?? [];
    runMeasurements.push(serializeMeasurement(measurement));
    measurementsByRun.set(runId, runMeasurements);
  }

  return results.map((row) => ({
    id: row.id,
    commitSha: row.commit_sha,
    shortSha: row.commit_sha.slice(0, 7),
    measuredAt: row.measured_at,
    measurements: measurementsByRun.get(row.id) ?? [],
  }));
}

export type PerformanceComparisonData = {
  badge: string;
  title: string;
  description: string;
  currentLabel: string;
  head: ReturnType<typeof runReference>;
  baseline: ReturnType<typeof runReference> | null;
  measurements: PerformanceComparisonMeasurementData[];
};

export async function getPullComparison(
  pullRequest: string,
): Promise<PerformanceComparisonData | null> {
  const pullNumber = Number(pullRequest);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return null;
  }

  const db = getD1();
  const pullRun = await db
    .prepare(`
      SELECT * FROM performance_runs
      WHERE kind = 'pull_request' AND pull_request = ?
      ORDER BY measured_at DESC LIMIT 1
    `)
    .bind(pullNumber)
    .first<Record<string, unknown>>();

  if (!pullRun) return null;

  const baselineRun = await db
    .prepare(`
      SELECT * FROM performance_runs
      WHERE kind = 'main' AND commit_sha = ?
      ORDER BY measured_at DESC LIMIT 1
    `)
    .bind(pullRun.base_sha)
    .first<Record<string, unknown>>();

  const measurements = await comparableMeasurements(
    String(pullRun.id),
    baselineRun ? String(baselineRun.id) : null,
  );
  if (measurements.length === 0) {
    return null;
  }

  return {
    badge: `PR #${pullNumber}`,
    title: `Pull request #${pullNumber}`,
    description: baselineRun
      ? "Exact-head measurements compared with the PR base commit. Directionality is defined per scenario."
      : "Exact-head measurements. No benchmark run is available for the PR base commit.",
    currentLabel: "PR head",
    head: runReference(pullRun),
    baseline: baselineRun ? runReference(baselineRun) : null,
    measurements,
  };
}

export async function getCommitComparison(sha: string): Promise<PerformanceComparisonData | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }

  const db = getD1();
  const normalizedSha = sha.toLowerCase();
  const currentRun =
    normalizedSha.length === 40
      ? await db
          .prepare(`
            SELECT * FROM performance_runs
            WHERE commit_sha = ?
            ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, measured_at DESC
            LIMIT 1
          `)
          .bind(normalizedSha)
          .first<Record<string, unknown>>()
      : await db
          .prepare(`
            SELECT * FROM performance_runs
            WHERE commit_sha >= ? AND commit_sha < ?
            ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, measured_at DESC
            LIMIT 1
          `)
          .bind(normalizedSha, `${normalizedSha}g`)
          .first<Record<string, unknown>>();

  if (!currentRun) return null;

  const isPullRequestRun = currentRun.kind === "pull_request";
  const baselineRun = isPullRequestRun
    ? await db
        .prepare(`
          SELECT * FROM performance_runs
          WHERE kind = 'main' AND commit_sha = ?
          ORDER BY measured_at DESC LIMIT 1
        `)
        .bind(currentRun.base_sha)
        .first<Record<string, unknown>>()
    : await db
        .prepare(`
          SELECT * FROM performance_runs
          WHERE kind = 'main' AND commit_sha != ? AND measured_at < ?
          ORDER BY measured_at DESC LIMIT 1
        `)
        .bind(currentRun.commit_sha, currentRun.measured_at)
        .first<Record<string, unknown>>();

  const measurements = await comparableMeasurements(
    String(currentRun.id),
    baselineRun ? String(baselineRun.id) : null,
  );
  if (measurements.length === 0) {
    return null;
  }

  const commitSha = String(currentRun.commit_sha);
  return {
    badge: commitSha.slice(0, 7),
    title: `Commit ${commitSha.slice(0, 7)}`,
    description: isPullRequestRun
      ? baselineRun
        ? "Pull-request measurements compared with the PR base commit. Directionality is defined per scenario."
        : "Pull-request measurements. No benchmark run is available for the PR base commit."
      : baselineRun
        ? "Main-branch measurements compared with the immediately preceding main run. Directionality is defined per scenario."
        : "Main-branch measurements. No earlier main run is available for a baseline comparison.",
    currentLabel: isPullRequestRun ? "PR commit" : "Current commit",
    head: runReference(currentRun),
    baseline: baselineRun ? runReference(baselineRun) : null,
    measurements,
  };
}

async function comparableMeasurements(
  currentRunId: string,
  baselineRunId: string | null,
): Promise<PerformanceComparisonMeasurementData[]> {
  const db = getD1();
  const [current, baseline] = await Promise.all([
    db
      .prepare("SELECT * FROM performance_measurements WHERE run_id = ? ORDER BY benchmark_id")
      .bind(currentRunId)
      .all<Record<string, unknown>>(),
    baselineRunId
      ? db
          .prepare("SELECT * FROM performance_measurements WHERE run_id = ? ORDER BY benchmark_id")
          .bind(baselineRunId)
          .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
  ]);
  const baselineById = new Map(baseline.results.map((row) => [String(row.benchmark_id), row]));

  return current.results.map((row) => {
    const baselineRow = baselineById.get(String(row.benchmark_id));
    return {
      benchmarkId: String(row.benchmark_id),
      scenarioId: String(row.scenario_id),
      suite: String(row.suite),
      label: String(row.label),
      description: String(row.description),
      implementationId: String(row.implementation_id),
      implementationLabel: String(row.implementation_label),
      unit: String(row.unit),
      lowerIsBetter: Boolean(row.lower_is_better),
      baseline: baselineRow ? measurementStats(baselineRow) : null,
      current: measurementStats(row),
      flameGraph:
        typeof row.flame_graph_json === "string"
          ? (JSON.parse(row.flame_graph_json) as FlameGraphData)
          : null,
      profileUrl:
        typeof row.profile_object_key === "string"
          ? `/api/benchmarks/profile?runId=${encodeURIComponent(currentRunId)}&benchmarkId=${encodeURIComponent(String(row.benchmark_id))}`
          : null,
    };
  });
}

export async function getPerformanceProfile(runId: string, benchmarkId: string): Promise<Response> {
  const row = await getD1()
    .prepare(`
      SELECT profile_object_key
      FROM performance_measurements
      WHERE run_id = ? AND benchmark_id = ?
    `)
    .bind(runId, benchmarkId)
    .first<{ profile_object_key: string | null }>();
  if (!row?.profile_object_key) return new Response("Profile not found", { status: 404 });

  const object = await getProfilesBucket().get(row.profile_object_key);
  if (!object) return new Response("Profile object not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Cache-Control": "private, max-age=300",
      ETag: object.httpEtag,
    },
  });
}

function runReference(row: Record<string, unknown>) {
  const sha = String(row.commit_sha);
  return { sha, shortSha: sha.slice(0, 7), measuredAt: String(row.measured_at) };
}

function serializeMeasurement(row: Record<string, unknown>): PerformanceMeasurementData {
  return {
    benchmarkId: String(row.benchmark_id),
    scenarioId: String(row.scenario_id),
    suite: String(row.suite),
    label: String(row.label),
    description: String(row.description),
    implementationId: String(row.implementation_id),
    implementationLabel: String(row.implementation_label),
    unit: String(row.unit),
    lowerIsBetter: Boolean(row.lower_is_better),
    median: Number(row.median_value),
    mean: Number(row.mean_value),
    standardDeviation: Number(row.standard_deviation_value),
    rounds: Number(row.rounds),
    min: Number(row.min_value),
    max: Number(row.max_value),
  };
}

function measurementStats(row: Record<string, unknown>): PerformanceStatsData {
  return {
    median: Number(row.median_value),
    mean: Number(row.mean_value),
    standardDeviation: Number(row.standard_deviation_value),
    rounds: Number(row.rounds),
    min: Number(row.min_value),
    max: Number(row.max_value),
  };
}
