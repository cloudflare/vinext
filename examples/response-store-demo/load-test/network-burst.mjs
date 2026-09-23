import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

const timestamp = new Date().toISOString().replaceAll(":", "-");
const options = {
  baseUrl:
    process.env.LOAD_TEST_BASE_URL ??
    "https://vinext-response-store-load-test.vinext.workers.dev",
  output: `results/network-burst-${timestamp}.json`,
  requests: 600,
  timeoutMs: 20_000,
};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const [name, inlineValue] = argument.split("=", 2);
  const value = inlineValue ?? args[++index];
  if (value === undefined) throw new TypeError(`${name} requires a value`);
  if (name === "--base-url") options.baseUrl = value;
  else if (name === "--output") options.output = value;
  else if (name === "--requests") options.requests = parsePositiveInteger(value, name);
  else if (name === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, name);
  else throw new TypeError(`Unknown argument ${name}`);
}

const baseUrl = options.baseUrl.replace(/\/$/, "");
const output = resolve(options.output);
const trace = Object.fromEntries(
  (await fetch("https://www.cloudflare.com/cdn-cgi/trace").then((response) => response.text()))
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2)),
);
const runId = `network-${Date.now().toString(36)}`;
const startedAt = new Date();
const started = performance.now();

const samples = await Promise.all(
  Array.from({ length: options.requests }, async (_, index) => {
    const requestStarted = performance.now();
    const url = `${baseUrl}/cacheable/${runId}-${index}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const body = await response.text();
      return {
        body: response.ok ? undefined : body,
        durationMs: performance.now() - requestStarted,
        headers: response.ok ? undefined : Object.fromEntries(response.headers),
        status: response.status,
        statusText: response.statusText,
        url,
      };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return {
        durationMs: performance.now() - requestStarted,
        error: {
          causeCode: cause instanceof Error && "code" in cause ? cause.code : undefined,
          causeMessage: cause instanceof Error ? cause.message : undefined,
          causeSyscall: cause instanceof Error && "syscall" in cause ? cause.syscall : undefined,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
        },
        status: null,
        url,
      };
    }
  }),
);

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

const statusTotals = Object.fromEntries(
  [...Map.groupBy(samples, (sample) => sample.status ?? "network-error")].map(([key, values]) => [
    key,
    values.length,
  ]),
);
const networkErrorTotals = Object.fromEntries(
  [...Map.groupBy(samples.filter((sample) => sample.error), (sample) => sample.error.causeMessage)].map(
    ([key, values]) => [key, values.length],
  ),
);
const durations = samples.map((sample) => sample.durationMs);
const result = {
  metadata: {
    baseUrl,
    durationMs: performance.now() - started,
    finishedAt: new Date().toISOString(),
    requests: options.requests,
    startedAt: startedAt.toISOString(),
    timeoutMs: options.timeoutMs,
    trace,
  },
  summary: {
    latencyMs: {
      max: durations.reduce((maximum, duration) => Math.max(maximum, duration), 0),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
    },
    networkErrorTotals,
    statusTotals,
  },
  firstHttpError: samples.find((sample) => sample.status && sample.status !== 200) ?? null,
  firstNetworkErrors: samples.filter((sample) => sample.error).slice(0, 5),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(output);
console.log(JSON.stringify(result.summary, null, 2));
