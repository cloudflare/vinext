import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const FRESH_SECONDS = 5;
const SWR_SECONDS = 15;
const ADMISSION_SETTLE_MS = 6_000;
const DEFAULT_CONCURRENCY = [25, 50, 100, 200];
const TOKEN_PATTERN = /data-render-token="([^"]+)"/;
const ID_PATTERN = /data-id="([^"]+)"/;

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.LOAD_TEST_BASE_URL,
    cacheable: 5_000,
    concurrency: DEFAULT_CONCURRENCY,
    dynamic: 5_000,
    output: `results/${new Date().toISOString().replaceAll(":", "-")}.json`,
    timeoutMs: 10_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new TypeError(`${name} requires a value`);

    if (name === "--base-url") options.baseUrl = value;
    else if (name === "--cacheable") options.cacheable = parsePositiveInteger(value, name);
    else if (name === "--dynamic") options.dynamic = parsePositiveInteger(value, name);
    else if (name === "--output") options.output = value;
    else if (name === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, name);
    else if (name === "--concurrency") {
      options.concurrency = value
        .split(",")
        .map((item) => parsePositiveInteger(item, name));
    } else {
      throw new TypeError(`Unknown argument ${name}`);
    }
  }

  if (!options.baseUrl) {
    throw new TypeError("Pass --base-url or set LOAD_TEST_BASE_URL");
  }
  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeDurations(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    mean: sorted.length ? total / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
}

function allocate(total, levels) {
  const weight = levels.reduce((sum, _value, index) => sum + index + 1, 0);
  let allocated = 0;
  return levels.map((_value, index) => {
    const count =
      index === levels.length - 1
        ? total - allocated
        : Math.floor((total * (index + 1)) / weight);
    allocated += count;
    return count;
  });
}

async function runConcurrent(count, concurrency, callback) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (cursor < count) {
        const index = cursor++;
        await callback(index);
      }
    }),
  );
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const options = parseArgs(process.argv.slice(2));
const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const startedAt = new Date();
const started = performance.now();
const buckets = new Map();
const allSamples = [];
const failures = [];
const lifecycle = {
  cacheable: { attempted: 0, succeeded: 0, failed: 0 },
  dynamic: { attempted: 0, succeeded: 0, failed: 0 },
};
const transitionTimings = {
  admissionMs: [],
  swrRecoveryMs: [],
};

function recordFailure(failure) {
  if (failures.length < 100) failures.push(failure);
}

function record(sample) {
  allSamples.push(sample);
  const elapsedSecond = Math.floor((sample.completedAt - started) / 1_000);
  const key = [elapsedSecond, sample.scenario, sample.phase, sample.concurrency].join(":");
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      cacheStates: {},
      concurrency: sample.concurrency,
      durations: [],
      elapsedSecond,
      errors: 0,
      phase: sample.phase,
      requests: 0,
      scenario: sample.scenario,
      statuses: {},
    };
    buckets.set(key, bucket);
  }
  bucket.requests += 1;
  bucket.durations.push(sample.durationMs);
  bucket.statuses[sample.status ?? "network-error"] =
    (bucket.statuses[sample.status ?? "network-error"] ?? 0) + 1;
  bucket.cacheStates[sample.cacheState ?? "missing"] =
    (bucket.cacheStates[sample.cacheState ?? "missing"] ?? 0) + 1;
  if (sample.error || sample.status !== 200) bucket.errors += 1;
}

async function request(path, scenario, phase, concurrency) {
  const requestStarted = performance.now();
  let response;
  let body = "";
  let error;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    body = await response.text();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const completedAt = performance.now();
  const sample = {
    age: Number(response?.headers.get("Age") ?? 0),
    cacheControl: response?.headers.get("Cache-Control") ?? null,
    cacheState:
      response?.headers.get("X-Vinext-Cache") ??
      response?.headers.get("X-Nextjs-Cache") ??
      null,
    cfCacheStatus: response?.headers.get("CF-Cache-Status") ?? null,
    completedAt,
    concurrency,
    durationMs: completedAt - requestStarted,
    error,
    id: ID_PATTERN.exec(body)?.[1] ?? null,
    phase,
    scenario,
    status: response?.status ?? null,
    token: TOKEN_PATTERN.exec(body)?.[1] ?? null,
  };
  record(sample);
  return sample;
}

async function eventually(check, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  let candidate;
  while (performance.now() < deadline) {
    candidate = await check();
    if (candidate.done) return candidate.sample;
    await sleep(250);
  }
  throw new Error(
    `transition timed out at ${JSON.stringify({
      cacheState: candidate?.sample.cacheState,
      status: candidate?.sample.status,
      token: candidate?.sample.token,
    })}`,
  );
}

async function runCacheableLifecycle(id, concurrency) {
  lifecycle.cacheable.attempted += 1;
  const path = `/cacheable/${id}`;
  try {
    const cold = await request(path, "cacheable", "cold-miss", concurrency);
    if (cold.status !== 200 || cold.cacheState !== "MISS" || !cold.token) {
      throw new Error(`cold request was not a valid MISS: ${JSON.stringify(cold)}`);
    }

    await sleep(ADMISSION_SETTLE_MS);
    const stored = await request(path, "cacheable", "stored-hit", concurrency);
    if (stored.status !== 200 || stored.cacheState !== "HIT" || stored.token !== cold.token) {
      throw new Error(`cold response was not admitted unchanged: ${JSON.stringify(stored)}`);
    }
    transitionTimings.admissionMs.push(stored.completedAt - cold.completedAt);

    await sleep(Math.max(250, (FRESH_SECONDS - stored.age + 0.25) * 1_000));

    const stale = await eventually(async () => {
      const sample = await request(path, "cacheable", "swr-trigger", concurrency);
      return {
        done:
          sample.status === 200 && sample.cacheState === "UPDATING" && sample.token === cold.token,
        sample,
      };
    }, SWR_SECONDS * 1_000);

    const recoveryStarted = stale.completedAt;
    const recovered = await eventually(async () => {
      const sample = await request(path, "cacheable", "recovered-hit", concurrency);
      return {
        done: sample.status === 200 && sample.cacheState === "HIT" && sample.token !== stale.token,
        sample,
      };
    }, SWR_SECONDS * 1_000);

    if (!recovered.token) throw new Error("recovered HIT had no render token");
    transitionTimings.swrRecoveryMs.push(recovered.completedAt - recoveryStarted);
    lifecycle.cacheable.succeeded += 1;
  } catch (error) {
    lifecycle.cacheable.failed += 1;
    recordFailure({
      concurrency,
      id,
      message: error instanceof Error ? error.message : String(error),
      scenario: "cacheable",
    });
  }
}

async function runDynamicLifecycle(id, concurrency) {
  lifecycle.dynamic.attempted += 1;
  const path = `/dynamic/${id}`;
  try {
    const first = await request(path, "dynamic", "dynamic-first", concurrency);
    const second = await request(path, "dynamic", "dynamic-repeat", concurrency);
    for (const sample of [first, second]) {
      if (
        sample.status !== 200 ||
        !sample.token ||
        sample.cacheState === "HIT" ||
        sample.cacheState === "UPDATING" ||
        !sample.cacheControl?.toLowerCase().includes("no-store")
      ) {
        throw new Error(`dynamic request was cacheable: ${JSON.stringify(sample)}`);
      }
    }
    if (first.token === second.token) {
      throw new Error(`dynamic render token was retained: ${first.token}`);
    }
    lifecycle.dynamic.succeeded += 1;
  } catch (error) {
    lifecycle.dynamic.failed += 1;
    recordFailure({
      concurrency,
      id,
      message: error instanceof Error ? error.message : String(error),
      scenario: "dynamic",
    });
  }
}

async function runScenario(name, total, callback) {
  const counts = allocate(total, options.concurrency);
  for (let level = 0; level < options.concurrency.length; level += 1) {
    const concurrency = options.concurrency[level];
    const count = counts[level];
    const offset = counts.slice(0, level).reduce((sum, value) => sum + value, 0);
    process.stderr.write(`${name}: ${count} lifecycles at concurrency ${concurrency}\n`);
    await runConcurrent(count, concurrency, (index) =>
      callback(`${runId}-${name}-${offset + index}`, concurrency),
    );

    const state = lifecycle[name];
    if (state.failed / state.attempted > 0.01) {
      process.stderr.write(`${name}: stopping after failure rate exceeded 1%\n`);
      break;
    }
  }
}

await runScenario("cacheable", options.cacheable, runCacheableLifecycle);
await runScenario("dynamic", options.dynamic, runDynamicLifecycle);

const finishedAt = new Date();
const summaries = [];
const summaryGroups = Map.groupBy(
  allSamples,
  (sample) => [sample.scenario, sample.phase, sample.concurrency].join(":"),
);
for (const samples of summaryGroups.values()) {
  const first = samples[0];
  const firstCompleted = Math.min(...samples.map((sample) => sample.completedAt));
  const lastCompleted = Math.max(...samples.map((sample) => sample.completedAt));
  const durationSeconds = Math.max(0.001, (lastCompleted - firstCompleted) / 1_000);
  summaries.push({
    cacheStates: Object.fromEntries(
      [...Map.groupBy(samples, (sample) => sample.cacheState ?? "missing")].map(
        ([state, values]) => [state, values.length],
      ),
    ),
    concurrency: first.concurrency,
    errors: samples.filter((sample) => sample.error || sample.status !== 200).length,
    phase: first.phase,
    requests: samples.length,
    responseTimeMs: summarizeDurations(samples.map((sample) => sample.durationMs)),
    rps: samples.length / durationSeconds,
    scenario: first.scenario,
  });
}

const result = {
  schemaVersion: 1,
  metadata: {
    baseUrl: options.baseUrl,
    client: {
      availableParallelism: availableParallelism(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    durationSeconds: (performance.now() - started) / 1_000,
    finishedAt: finishedAt.toISOString(),
    gitSha: process.env.GIT_SHA ?? null,
    runId,
    startedAt: startedAt.toISOString(),
    workerVersions: {
      app: process.env.APP_VERSION_ID ?? null,
      cache: process.env.CACHE_VERSION_ID ?? null,
    },
  },
  config: {
    admissionSettleMs: ADMISSION_SETTLE_MS,
    cacheableLifecycles: options.cacheable,
    concurrency: options.concurrency,
    dynamicLifecycles: options.dynamic,
    freshnessSeconds: FRESH_SECONDS,
    swrSeconds: SWR_SECONDS,
    timeoutMs: options.timeoutMs,
  },
  lifecycle,
  transitionTimeMs: {
    admission: summarizeDurations(transitionTimings.admissionMs),
    swrRecovery: summarizeDurations(transitionTimings.swrRecoveryMs),
  },
  series: [...buckets.values()]
    .map(({ durations, ...bucket }) => ({
      ...bucket,
      responseTimeMs: summarizeDurations(durations),
      rps: bucket.requests,
      timestamp: new Date(startedAt.getTime() + bucket.elapsedSecond * 1_000).toISOString(),
    }))
    .sort(
      (left, right) =>
        left.elapsedSecond - right.elapsedSecond || left.phase.localeCompare(right.phase),
    ),
  summaries: summaries.sort(
    (left, right) =>
      left.scenario.localeCompare(right.scenario) ||
      left.concurrency - right.concurrency ||
      left.phase.localeCompare(right.phase),
  ),
  failures,
};

const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${output}\n`);
process.stdout.write(`${JSON.stringify({ lifecycle, requests: allSamples.length }, null, 2)}\n`);

if (lifecycle.cacheable.failed || lifecycle.dynamic.failed) process.exitCode = 1;
