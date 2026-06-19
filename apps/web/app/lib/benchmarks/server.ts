import { env } from "cloudflare:workers";
import { revalidatePath } from "next/cache";

type CloudflareEnv = {
  DB: D1Database;
  PERFORMANCE_PROFILES: R2Bucket;
};

type NormalizedPerfPayload = {
  schemaVersion: 1 | 2;
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
    skippedImplementations?: string[];
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
    baselineSamples?: {
      rounds: number;
      mean: number;
      median: number;
      standardDeviation: number;
      min: number;
      max: number;
      q1: number;
      q3: number;
      outliers: number;
    } | null;
    profileRounds?: number | null;
    profileObjectKey?: string;
  }>;
};

function getD1() {
  return (env as CloudflareEnv).DB;
}

function getProfilesBucket() {
  return (env as CloudflareEnv).PERFORMANCE_PROFILES;
}

function executionOrder(executionId: string) {
  const match = /^(\d+):(\d+)$/.exec(executionId);
  if (!match) return null;
  const runId = Number(match[1]);
  const attempt = Number(match[2]);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt)) return null;
  return [runId, attempt] as const;
}

export async function uploadPerformanceRun(request: Request): Promise<Response> {
  let body: NormalizedPerfPayload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    (body.schemaVersion !== 1 && body.schemaVersion !== 2) ||
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
    body.schemaVersion === 2 &&
    !body.benchmarks.some((benchmark) => benchmark.baselineSamples != null)
  ) {
    return Response.json(
      { error: "Performance schema 2 requires paired baseline samples" },
      { status: 400 },
    );
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
  const incomingExecution = executionOrder(body.run.executionId);
  if (!incomingExecution) {
    return Response.json({ error: "Invalid performance execution ID" }, { status: 400 });
  }
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
        INSERT INTO performance_runs (
          id, kind, commit_sha, base_sha, pull_request, measured_at,
          provider, instrument, repository, system_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          commit_sha = excluded.commit_sha,
          base_sha = excluded.base_sha,
          pull_request = excluded.pull_request,
          measured_at = excluded.measured_at,
          provider = excluded.provider,
          instrument = excluded.instrument,
          repository = excluded.repository,
          system_json = excluded.system_json
        WHERE json_extract(performance_runs.system_json, '$.executionRunId') IS NULL
          OR CAST(json_extract(performance_runs.system_json, '$.executionRunId') AS INTEGER) < ?
          OR (
            CAST(json_extract(performance_runs.system_json, '$.executionRunId') AS INTEGER) = ?
            AND CAST(json_extract(performance_runs.system_json, '$.executionAttempt') AS INTEGER) < ?
          )
        RETURNING id
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
        JSON.stringify({
          ...body.system,
          executionId: body.run.executionId,
          executionRunId: incomingExecution[0],
          executionAttempt: incomingExecution[1],
        }),
        incomingExecution[0],
        incomingExecution[0],
        incomingExecution[1],
      ),
    db
      .prepare(`
        DELETE FROM performance_measurements
        WHERE run_id = ?
          AND EXISTS (
            SELECT 1 FROM performance_runs
            WHERE id = ?
              AND CAST(json_extract(system_json, '$.executionRunId') AS INTEGER) = ?
              AND CAST(json_extract(system_json, '$.executionAttempt') AS INTEGER) = ?
          )
        RETURNING profile_object_key
      `)
      .bind(runId, runId, incomingExecution[0], incomingExecution[1]),
    ...body.benchmarks.map((benchmark) =>
      db
        .prepare(`
          INSERT INTO performance_measurements (
            run_id, benchmark_id, scenario_id, suite, label, description,
            implementation_id, implementation_label, unit,
            lower_is_better, rounds, mean_value, median_value,
            standard_deviation_value, min_value, max_value, q1_value,
            q3_value, outliers, paired_baseline_rounds,
            paired_baseline_mean_value, paired_baseline_median_value,
            paired_baseline_standard_deviation_value, paired_baseline_min_value,
            paired_baseline_max_value, paired_baseline_q1_value,
            paired_baseline_q3_value, paired_baseline_outliers,
            flame_graph_json, profile_rounds, profile_object_key
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM performance_runs
            WHERE id = ?
              AND CAST(json_extract(system_json, '$.executionRunId') AS INTEGER) = ?
              AND CAST(json_extract(system_json, '$.executionAttempt') AS INTEGER) = ?
          )
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
          benchmark.baselineSamples?.rounds ?? null,
          benchmark.baselineSamples?.mean ?? null,
          benchmark.baselineSamples?.median ?? null,
          benchmark.baselineSamples?.standardDeviation ?? null,
          benchmark.baselineSamples?.min ?? null,
          benchmark.baselineSamples?.max ?? null,
          benchmark.baselineSamples?.q1 ?? null,
          benchmark.baselineSamples?.q3 ?? null,
          benchmark.baselineSamples?.outliers ?? null,
          null,
          benchmark.profileRounds ?? null,
          profileKeys.get(benchmark.benchmarkId) ?? null,
          runId,
          incomingExecution[0],
          incomingExecution[1],
        ),
    ),
  ];

  const [claimedRun, deletedMeasurements] = await db.batch(statements);
  if (claimedRun.results.length === 0) {
    return Response.json({ error: "Stale performance execution" }, { status: 409 });
  }
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
  baselineSource: "paired" | "historical" | null;
  current: PerformanceStatsData;
  flameGraph: FlameGraphData | null;
  profileRounds: number | null;
  profileUrl: string | null;
};

export async function getPerformanceRuns(limit = 100): Promise<PerformanceRunData[]> {
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
  baseline: {
    sha: string;
    shortSha: string;
    measuredAt: string | null;
  } | null;
  baselineLabel: string;
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
  const provenance = comparisonProvenance(measurements);

  return {
    badge: `PR #${pullNumber}`,
    title: `Pull request #${pullNumber}`,
    description: comparisonDescription(provenance, "Exact-head measurements."),
    currentLabel: "PR head",
    head: runReference(pullRun),
    baseline: comparisonBaseline(provenance, pullRun, baselineRun),
    baselineLabel: comparisonBaselineLabel(provenance),
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
  const provenance = comparisonProvenance(measurements);

  const commitSha = String(currentRun.commit_sha);
  return {
    badge: commitSha.slice(0, 7),
    title: `Commit ${commitSha.slice(0, 7)}`,
    description: isPullRequestRun
      ? comparisonDescription(provenance, "Pull-request measurements.")
      : baselineRun
        ? "Main-branch measurements compared with the immediately preceding main run. Directionality is defined per scenario."
        : "Main-branch measurements. No earlier main run is available for a baseline comparison.",
    currentLabel: isPullRequestRun ? "PR commit" : "Current commit",
    head: runReference(currentRun),
    baseline: isPullRequestRun
      ? comparisonBaseline(provenance, currentRun, baselineRun)
      : baselineRun
        ? runReference(baselineRun)
        : null,
    baselineLabel: comparisonBaselineLabel(provenance),
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
      baseline:
        row.paired_baseline_rounds !== null
          ? pairedMeasurementStats(row)
          : baselineRow
            ? measurementStats(baselineRow)
            : null,
      baselineSource:
        row.paired_baseline_rounds !== null ? "paired" : baselineRow ? "historical" : null,
      current: measurementStats(row),
      flameGraph:
        typeof row.flame_graph_json === "string"
          ? (JSON.parse(row.flame_graph_json) as FlameGraphData)
          : null,
      profileRounds: typeof row.profile_rounds === "number" ? Number(row.profile_rounds) : null,
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

function pairedBaselineReference(row: Record<string, unknown>) {
  const sha = String(row.base_sha);
  return { sha, shortSha: sha.slice(0, 7), measuredAt: null };
}

function mixedBaselineReference(row: Record<string, unknown>) {
  const sha = String(row.base_sha);
  return { sha, shortSha: sha.slice(0, 7), measuredAt: null };
}

function comparisonProvenance(measurements: PerformanceComparisonMeasurementData[]) {
  const sources = new Set(measurements.map((measurement) => measurement.baselineSource));
  const paired = sources.has("paired");
  const historical = sources.has("historical");
  const missing = sources.has(null);
  if (paired && historical && missing) return "mixed-partial";
  if (paired && historical) return "mixed";
  if (paired && missing) return "paired-partial";
  if (historical && missing) return "historical-partial";
  if (paired) return "paired";
  if (historical) return "historical";
  return "none";
}

function comparisonDescription(
  provenance: ReturnType<typeof comparisonProvenance>,
  prefix: string,
) {
  if (provenance === "paired") {
    return `${prefix} Head and base were measured together on the same runner with alternating rounds.`;
  }
  if (provenance === "mixed") {
    return `${prefix} Paired rows use same-runner base measurements; unpaired rows use a historical run of the base commit.`;
  }
  if (provenance === "mixed-partial") {
    return `${prefix} Paired rows use same-runner base measurements, other available rows use a historical base run, and remaining rows have no baseline.`;
  }
  if (provenance === "paired-partial") {
    return `${prefix} Paired rows use same-runner base measurements; remaining rows have no baseline.`;
  }
  if (provenance === "historical") {
    return `${prefix} Compared with a historical run of the base commit.`;
  }
  if (provenance === "historical-partial") {
    return `${prefix} Available rows use a historical run of the base commit; remaining rows have no baseline.`;
  }
  return `${prefix} No benchmark run is available for the base commit.`;
}

function comparisonBaseline(
  provenance: ReturnType<typeof comparisonProvenance>,
  currentRun: Record<string, unknown>,
  historicalRun: Record<string, unknown> | null,
) {
  if (provenance === "paired" || provenance === "paired-partial") {
    return pairedBaselineReference(currentRun);
  }
  if (provenance === "mixed" || provenance === "mixed-partial") {
    return mixedBaselineReference(currentRun);
  }
  if ((provenance === "historical" || provenance === "historical-partial") && historicalRun) {
    return runReference(historicalRun);
  }
  return null;
}

function comparisonBaselineLabel(provenance: ReturnType<typeof comparisonProvenance>) {
  if (provenance === "mixed" || provenance === "mixed-partial") return "Mixed baselines";
  if (provenance === "paired-partial") return "Paired baseline";
  return "Baseline";
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

function pairedMeasurementStats(row: Record<string, unknown>): PerformanceStatsData {
  return {
    median: Number(row.paired_baseline_median_value),
    mean: Number(row.paired_baseline_mean_value),
    standardDeviation: Number(row.paired_baseline_standard_deviation_value),
    rounds: Number(row.paired_baseline_rounds),
    min: Number(row.paired_baseline_min_value),
    max: Number(row.paired_baseline_max_value),
  };
}
