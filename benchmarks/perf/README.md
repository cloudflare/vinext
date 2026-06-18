# Performance benchmarks

The performance pipeline is scenario-driven. CI, normalization, D1 storage, PR
comparison, units, directionality, labels, and optional flame profiles all use
metadata from `scenarios.mjs`.

## Adding a scenario

1. Add any one-time setup command to `performanceSetup` in `scenarios.mjs`.
2. Add one scenario with its implementations to `performanceScenarios`.
3. Point each implementation at an adapter command that reports one numeric value
   with `reportPerformanceSample(value)`.

No workflow, database, API, normalizer, or dashboard changes are required.

```js
{
  id: "production-build",
  suite: "Build",
  label: "Production build time",
  description: "Clean production build.",
  unit: "ms",
  lowerIsBetter: true,
  implementations: [
    {
      id: "vinext",
      label: "vinext",
      profile: true,
      command: ["node", "benchmarks/perf/build-time.mjs", "vinext"],
    },
  ],
}
```

The full benchmark ID is generated as `<implementation id>-<scenario id>`.
Profiling is configured per implementation. Set `profile: true` only for the
implementation whose subprocess tree should be sampled; the current scenarios
capture vinext traces and never profile Next.js.

Set `compareBase: true` for implementations that should be measured at both the
pull request base and head. PR CI prepares both revisions on one runner and uses
alternating AB/BA rounds, so the reported delta is not derived from historical
runner performance. Profiles are captured separately from the paired timing
rounds and do not add samples to the comparison.

PR runs fingerprint the complete Next.js benchmark input: its non-generated
project files, the shared app generator, scenario definitions, and measurement
runtime scripts, normalization, and the performance workflow. When those inputs
are unchanged, Next.js is omitted from the PR run. When they change, Next.js is
measured as another paired base/head implementation. Main runs continue to
measure both frameworks.

## Running locally

Prepare all configured scenarios:

```bash
node benchmarks/perf/run-scenarios.mjs --setup-only
```

Run one direct sample for every configured implementation without the CI profiler:

```bash
VINEXT_PERF_SAMPLES="$PWD/benchmarks/results/perf-samples.jsonl" \
  node benchmarks/perf/run-scenarios.mjs --direct --rounds=1
```

Run the CI measurement path when the pinned CodSpeed runner and its wall-time
harness are available:

```bash
VINEXT_PERF_SAMPLES="$PWD/benchmarks/results/perf-samples.jsonl" \
  node benchmarks/perf/run-scenarios.mjs
```

Main CI records five unprofiled timing rounds for every benchmark. Pull request
comparisons use six alternating base/head timing rounds by default.
Implementations marked with `profile: true` then run once more under Samply
solely to capture a diagnostic profile. The profiled value is discarded and
does not contribute to the reported timing statistics.

Pull request runs measure GitHub's synthetic merge commit so an out-of-date
branch is benchmarked as it would land on the current base branch. Results keep
the pull request head SHA as their identity for dashboard history and comments.

CI sets `CODSPEED_SKIP_UPLOAD=true`. Results and profiles remain local to the
GitHub runner, are normalized into the owned payload format, and are uploaded
only to the vinext dashboard.
