import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const FRESH_SECONDS = 15;
const SWR_SECONDS = 15;
const ADMISSION_SETTLE_MS = 6_000;
const DEFAULT_CONCURRENCY = [50, 100, 200, 400, 800];
const LOAD_MODES = new Set(["lifecycle", "miss", "dynamic", "fill"]);
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
    keys: 1,
    maxConcurrency: 2_000,
    mode: "lifecycle",
    output: `results/${new Date().toISOString().replaceAll(":", "-")}.json`,
    requests: 50_000,
    rps: undefined,
    stagePauseSeconds: 0,
    stageSeconds: undefined,
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
    else if (name === "--keys") options.keys = parsePositiveInteger(value, name);
    else if (name === "--max-concurrency") {
      options.maxConcurrency = parsePositiveInteger(value, name);
    } else if (name === "--mode") options.mode = value;
    else if (name === "--output") options.output = value;
    else if (name === "--requests") options.requests = parsePositiveInteger(value, name);
    else if (name === "--rps") {
      options.rps = value.split(",").map((item) => parsePositiveInteger(item, name));
    } else if (name === "--stage-pause-seconds") {
      options.stagePauseSeconds = parsePositiveInteger(value, name);
    } else if (name === "--stage-seconds") {
      options.stageSeconds = value.split(",").map((item) => parsePositiveInteger(item, name));
    } else if (name === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, name);
    else if (name === "--concurrency") {
      options.concurrency = value.split(",").map((item) => parsePositiveInteger(item, name));
    } else {
      throw new TypeError(`Unknown argument ${name}`);
    }
  }

  if (!options.baseUrl) {
    throw new TypeError("Pass --base-url or set LOAD_TEST_BASE_URL");
  }
  if (!LOAD_MODES.has(options.mode)) {
    throw new TypeError(`--mode must be one of ${[...LOAD_MODES].join(", ")}`);
  }
  if (options.stageSeconds && options.mode === "lifecycle") {
    throw new TypeError("--stage-seconds is only supported by throughput modes");
  }
  if (options.rps && options.mode === "lifecycle") {
    throw new TypeError("--rps is only supported by throughput modes");
  }
  if (options.rps && !options.stageSeconds) {
    throw new TypeError("--rps requires --stage-seconds");
  }
  if (options.rps && options.rps.length !== options.stageSeconds.length) {
    throw new TypeError("--rps must have one value for each --stage-seconds value");
  }
  if (
    !options.rps &&
    options.stageSeconds &&
    options.stageSeconds.length !== options.concurrency.length
  ) {
    throw new TypeError("--stage-seconds must have one value for each --concurrency value");
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
      index === levels.length - 1 ? total - allocated : Math.floor((total * (index + 1)) / weight);
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

async function runConcurrentForDuration(durationSeconds, concurrency, callback) {
  const deadline = performance.now() + durationSeconds * 1_000;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        await callback(cursor++);
      }
    }),
  );
}

async function runAtRate(durationSeconds, rps, maxConcurrency, callback) {
  const started = performance.now();
  const deadline = started + durationSeconds * 1_000;
  const inFlight = new Set();
  const scheduledRequests = durationSeconds * rps;
  let cursor = 0;

  while (cursor < scheduledRequests && performance.now() < deadline) {
    const scheduledAt = started + (cursor * 1_000) / rps;
    const delay = scheduledAt - performance.now();
    if (delay > 0) await sleep(delay);
    if (performance.now() >= deadline) break;
    if (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight);
      if (performance.now() >= deadline) break;
    }

    const pending = callback(cursor++).finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  }

  await Promise.all(inFlight);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function getNetworkTrace() {
  try {
    const body = await fetch("https://www.cloudflare.com/cdn-cgi/trace").then((response) =>
      response.text(),
    );
    return Object.fromEntries(
      body
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function serializeError(error) {
  if (!(error instanceof Error)) return error === undefined ? undefined : { message: String(error) };
  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name,
    syscall: "syscall" in error ? error.syscall : undefined,
  };
}

const options = parseArgs(process.argv.slice(2));
const networkTrace = await getNetworkTrace();
const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const startedAt = new Date();
const started = performance.now();
const buckets = new Map();
const allSamples = [];
const failures = [];
const diagnostics = {
  firstHttpError: null,
  firstNetworkError: null,
};
const lifecycle = {
  cacheable: { attempted: 0, succeeded: 0, failed: 0 },
  dynamic: { attempted: 0, succeeded: 0, failed: 0 },
};
const throughput = { attempted: 0, succeeded: 0, failed: 0 };
const transitionTimings = {
  admissionMs: [],
  swrRecoveryMs: [],
};
const stages = [];
let activeStage;

function recordFailure(failure) {
  if (failures.length < 100) failures.push(failure);
}

function recordAggregate(aggregate, sample) {
  aggregate.requests += 1;
  aggregate.durations.push(sample.durationMs);
  aggregate.statuses[sample.status ?? "network-error"] =
    (aggregate.statuses[sample.status ?? "network-error"] ?? 0) + 1;
  aggregate.cacheStates[sample.cacheState ?? "missing"] =
    (aggregate.cacheStates[sample.cacheState ?? "missing"] ?? 0) + 1;
}

function record(sample) {
  if (options.mode === "lifecycle") allSamples.push(sample);

  const elapsedSecond = Math.floor((sample.completedAt - started) / 1_000);
  const key = [
    elapsedSecond,
    sample.scenario,
    sample.phase,
    sample.concurrency,
    sample.targetRps ?? "",
  ].join(":");
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
      ...(sample.targetRps ? { targetRps: sample.targetRps } : {}),
    };
    buckets.set(key, bucket);
  }
  recordAggregate(bucket, sample);
  if (!sample.ok) bucket.errors += 1;
  if (activeStage) recordAggregate(activeStage, sample);
}

async function request(path, scenario, phase, concurrency, expectedStatus = 200, targetRps) {
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
    diagnostics.firstNetworkError ??= {
      error: serializeError(caught),
      cause: serializeError(caught instanceof Error ? caught.cause : undefined),
      path,
      phase,
      scenario,
    };
  }
  const completedAt = performance.now();
  const sample = {
    age: Number(response?.headers.get("Age") ?? 0),
    cacheControl: response?.headers.get("Cache-Control") ?? null,
    cacheState:
      response?.headers.get("X-Vinext-Cache") ?? response?.headers.get("X-Nextjs-Cache") ?? null,
    cfCacheStatus: response?.headers.get("CF-Cache-Status") ?? null,
    completedAt,
    concurrency,
    durationMs: completedAt - requestStarted,
    error,
    id: ID_PATTERN.exec(body)?.[1] ?? null,
    ok: !error && response?.status === expectedStatus,
    phase,
    scenario,
    status: response?.status ?? null,
    ...(targetRps ? { targetRps } : {}),
    token: TOKEN_PATTERN.exec(body)?.[1] ?? null,
  };
  if (response && !sample.ok && diagnostics.firstHttpError === null) {
    diagnostics.firstHttpError = {
      body,
      headers: Object.fromEntries(response.headers),
      path,
      phase,
      scenario,
      status: response.status,
      statusText: response.statusText,
    };
  }
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

async function runThroughputRequest(index, concurrency, targetRps) {
  throughput.attempted += 1;
  const isFill = options.mode === "fill";
  const key = isFill ? index : index % options.keys;
  const isMiss = options.mode === "miss";
  const sample = await request(
    isMiss
      ? `/not-found/${runId}-${key}`
      : isFill
        ? `/cacheable/${runId}-${key}`
        : `/dynamic/${runId}-${key}`,
    options.mode,
    "request",
    concurrency,
    isMiss ? 404 : 200,
    targetRps,
  );
  const valid =
    sample.ok &&
    (isFill
      ? sample.cacheState === "MISS" && sample.token
      : sample.cacheState !== "HIT" &&
        sample.cacheState !== "UPDATING" &&
        (isMiss || (sample.token && sample.cacheControl?.toLowerCase().includes("no-store"))));
  if (valid) {
    throughput.succeeded += 1;
    return;
  }

  throughput.failed += 1;
  recordFailure({
    concurrency,
    key,
    message: `unexpected ${options.mode} response: ${JSON.stringify(sample)}`,
    scenario: options.mode,
  });
}

async function runThroughput() {
  const counts = options.stageSeconds ? undefined : allocate(options.requests, options.concurrency);
  const levels = options.rps ?? options.concurrency;
  let offset = 0;
  for (let level = 0; level < levels.length; level += 1) {
    const targetRps = options.rps?.[level];
    const concurrency = targetRps ? options.maxConcurrency : options.concurrency[level];
    const count = counts?.[level];
    const targetDurationSeconds = options.stageSeconds?.[level];
    process.stderr.write(
      targetRps
        ? `${options.mode}: ${targetDurationSeconds}s at ${targetRps} RPS (max concurrency ${concurrency})\n`
        : targetDurationSeconds
          ? `${options.mode}: ${targetDurationSeconds}s at concurrency ${concurrency}\n`
          : `${options.mode}: ${count} requests at concurrency ${concurrency}\n`,
    );
    const succeededBefore = throughput.succeeded;
    const failedBefore = throughput.failed;
    const stageStarted = performance.now();
    activeStage = { cacheStates: {}, durations: [], requests: 0, statuses: {} };
    if (targetRps) {
      await runAtRate(targetDurationSeconds, targetRps, concurrency, (index) =>
        runThroughputRequest(offset + index, concurrency, targetRps),
      );
    } else if (targetDurationSeconds) {
      await runConcurrentForDuration(targetDurationSeconds, concurrency, (index) =>
        runThroughputRequest(offset + index, concurrency),
      );
    } else {
      await runConcurrent(count, concurrency, (index) =>
        runThroughputRequest(offset + index, concurrency),
      );
    }
    const stageFinished = performance.now();
    const stage = activeStage;
    activeStage = undefined;
    const requests = stage.requests;
    offset += requests;
    const durationSeconds = Math.max(0.001, (stageFinished - stageStarted) / 1_000);
    stages.push({
      cacheStates: stage.cacheStates,
      concurrency,
      durationSeconds,
      failed: throughput.failed - failedBefore,
      requests,
      responseTimeMs: summarizeDurations(stage.durations),
      rps: requests / durationSeconds,
      startedAt: new Date(startedAt.getTime() + stageStarted - started).toISOString(),
      statuses: stage.statuses,
      succeeded: throughput.succeeded - succeededBefore,
      ...(targetDurationSeconds ? { offeredRps: requests / targetDurationSeconds } : {}),
      ...(targetRps ? { targetRps } : {}),
      ...(targetDurationSeconds ? { targetDurationSeconds } : {}),
    });
    if (!options.stageSeconds && (throughput.failed - failedBefore) / requests > 0.01) {
      process.stderr.write(`${options.mode}: stopping after failure rate exceeded 1%\n`);
      break;
    }
    if (options.stagePauseSeconds && level < levels.length - 1) {
      process.stderr.write(`${options.mode}: pausing ${options.stagePauseSeconds}s for admissions\n`);
      await sleep(options.stagePauseSeconds * 1_000);
    }
  }
}

if (options.mode === "lifecycle") {
  await runScenario("cacheable", options.cacheable, runCacheableLifecycle);
  await runScenario("dynamic", options.dynamic, runDynamicLifecycle);
} else {
  await runThroughput();
}

const finishedAt = new Date();
const summaries = [];
if (options.mode === "lifecycle") {
  const summaryGroups = Map.groupBy(allSamples, (sample) =>
    [sample.scenario, sample.phase, sample.concurrency].join(":"),
  );
  for (const samples of summaryGroups.values()) {
    const first = samples[0];
    const durationSeconds = Math.max(
      0.001,
      (samples.at(-1).completedAt - first.completedAt) / 1_000,
    );
    summaries.push({
      cacheStates: Object.fromEntries(
        [...Map.groupBy(samples, (sample) => sample.cacheState ?? "missing")].map(
          ([state, values]) => [state, values.length],
        ),
      ),
      concurrency: first.concurrency,
      errors: samples.filter((sample) => !sample.ok).length,
      phase: first.phase,
      requests: samples.length,
      responseTimeMs: summarizeDurations(samples.map((sample) => sample.durationMs)),
      rps: samples.length / durationSeconds,
      scenario: first.scenario,
    });
  }
} else {
  for (const stage of stages) {
    summaries.push({
      cacheStates: stage.cacheStates,
      concurrency: stage.concurrency,
      errors: stage.failed,
      phase: "request",
      requests: stage.requests,
      responseTimeMs: stage.responseTimeMs,
      rps: stage.rps,
      scenario: options.mode,
      ...(stage.targetRps ? { targetRps: stage.targetRps } : {}),
    });
  }
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
    gitDirty: process.env.GIT_DIRTY === "1",
    gitSha: process.env.GIT_SHA ?? null,
    networkTrace,
    runId,
    startedAt: startedAt.toISOString(),
    workerVersions: {
      app: process.env.APP_VERSION_ID ?? null,
      cache: process.env.CACHE_VERSION_ID ?? null,
    },
  },
  config: {
    mode: options.mode,
    router: "app",
    timeoutMs: options.timeoutMs,
    ...(options.mode === "lifecycle"
      ? {
          admissionSettleMs: ADMISSION_SETTLE_MS,
          cacheableLifecycles: options.cacheable,
          concurrency: options.concurrency,
          dynamicLifecycles: options.dynamic,
          freshnessSeconds: FRESH_SECONDS,
          swrSeconds: SWR_SECONDS,
        }
      : {
          ...(options.mode === "fill" ? { uniqueKeys: true } : { keys: options.keys }),
          ...(options.rps
            ? {
                maxConcurrency: options.maxConcurrency,
                rps: options.rps,
                stagePauseSeconds: options.stagePauseSeconds,
              }
            : { concurrency: options.concurrency }),
          ...(options.stageSeconds
            ? { stageSeconds: options.stageSeconds }
            : { requests: options.requests }),
        }),
  },
  diagnostics,
  lifecycle,
  throughput,
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
  stages,
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
process.stdout.write(
  `${JSON.stringify(
    {
      ...(options.mode === "lifecycle" ? { lifecycle } : { throughput }),
      requests: options.mode === "lifecycle" ? allSamples.length : throughput.attempted,
    },
    null,
    2,
  )}\n`,
);

if (
  options.mode === "lifecycle"
    ? lifecycle.cacheable.failed || lifecycle.dynamic.failed
    : throughput.failed
) {
  process.exitCode = 1;
}
