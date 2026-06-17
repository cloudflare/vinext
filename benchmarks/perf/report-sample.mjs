import { appendFile } from "node:fs/promises";

export async function reportPerformanceSample(value) {
  if (!Number.isFinite(value))
    throw new Error(`Performance sample must be finite, received ${value}`);

  const sample = {
    schemaVersion: 1,
    benchmarkId: requiredEnvironment("VINEXT_PERF_BENCHMARK_ID"),
    scenarioId: requiredEnvironment("VINEXT_PERF_SCENARIO_ID"),
    suite: requiredEnvironment("VINEXT_PERF_SUITE"),
    label: requiredEnvironment("VINEXT_PERF_LABEL"),
    description: process.env.VINEXT_PERF_DESCRIPTION ?? "",
    implementationId: requiredEnvironment("VINEXT_PERF_IMPLEMENTATION_ID"),
    implementationLabel: requiredEnvironment("VINEXT_PERF_IMPLEMENTATION_LABEL"),
    profile: process.env.VINEXT_PERF_PROFILE === "true",
    unit: requiredEnvironment("VINEXT_PERF_UNIT"),
    lowerIsBetter: process.env.VINEXT_PERF_LOWER_IS_BETTER !== "false",
    value,
    measuredAt: new Date().toISOString(),
  };

  const samplesFile = requiredEnvironment("VINEXT_PERF_SAMPLES");
  await appendFile(samplesFile, `${JSON.stringify(sample)}\n`);
  console.log(JSON.stringify(sample));
  return sample;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run the adapter through run-scenarios.mjs`);
  return value;
}
