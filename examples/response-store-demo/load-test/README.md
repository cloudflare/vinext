# Workers Response Store load test

This isolated App Router app exercises two production Response Store paths:

- `/cacheable/:id` uses 15 seconds of freshness and a 15-second SWR window, then verifies the
  transition from `MISS` to stored `HIT`, stale `UPDATING`, and a recovered `HIT` with a new render
  token.
- `/dynamic/:id` is requested twice at the same URL and verifies that a `no-store` response is not
  retained.

The dependency-free runner writes chart-ready per-second RPS, response-time percentiles, cache
states, errors, and lifecycle summaries to `results/*.json`.

## Prerequisites

- Install the repository dependencies from the frozen lockfile and build the vinext,
  `@vinext/cloudflare`, and `@cloudflare/workers-response-store` packages.
- Authenticate Wrangler with access to the account configured in the two Wrangler files.
- Create the R2 bucket once. Keep the bucket, Workers, and Durable Object namespace after a run so
  later experiments use the same infrastructure.

Build the required workspace packages from the repository root, then run the remaining commands
from `examples/response-store-demo`:

```sh
vp run @cloudflare/workers-response-store#build
vp run @vinext/cloudflare#build
vp run vinext#build
cd examples/response-store-demo
```

## Build and deploy

Create the bucket only if it does not already exist:

```sh
pnpm exec wrangler r2 bucket create vinext-response-store-load-test-bodies --location weur
```

Build the app, then deploy the cache Worker before the app Worker:

```sh
pnpm exec sh -c 'cd load-test && node ../../../packages/vinext/dist/cli.js build'
pnpm exec wrangler deploy --config load-test/wrangler.response-store.jsonc
pnpm exec wrangler deploy --config load-test/dist/server/wrangler.json
```

Both Workers enable logs, invocation logs, traces, and 1% head sampling. Do not delete the R2
bucket or deployed Workers after the experiment.

## Run the test

Start with a small lifecycle check:

```sh
pnpm exec sh -c 'cd load-test && node load.mjs --base-url https://vinext-response-store-load-test.vinext.workers.dev --cacheable 4 --dynamic 4 --concurrency 2 --output results/smoke.json'
```

The default high-load run executes 5,000 cacheable and 5,000 dynamic lifecycles across concurrency
levels 50, 100, 200, 400, and 800:

```sh
pnpm exec sh -c 'cd load-test && GIT_SHA=$(git rev-parse HEAD) GIT_DIRTY=$(test -n "$(git status --porcelain)" && echo 1 || echo 0) node load.mjs --base-url https://vinext-response-store-load-test.vinext.workers.dev --timeout-ms 20000'
```

Available options are `--base-url`, `--cacheable`, `--dynamic`, `--concurrency`, `--timeout-ms`,
and `--output`. `--concurrency` accepts a comma-separated progression such as `50,100,200`.
`LOAD_TEST_BASE_URL` may be used instead of `--base-url`.

The runner stops a scenario after its cumulative lifecycle failure rate exceeds 1% and exits
non-zero if any lifecycle failed.

## Read the JSON output

- `series` contains one point per second and phase, including RPS, latency percentiles, status
  codes, cache states, and errors. Use `timestamp` as the line-chart x-axis.
- `summaries` aggregates those measurements by scenario, phase, and concurrency.
- `lifecycle` reports attempted, successful, and failed cacheable and dynamic lifecycles.
- `transitionTimeMs` reports cache admission and SWR recovery latency.
- `metadata` records the target, client, git revision, run ID, and optional deployed Worker version
  IDs.

Results are intentionally ignored by git. To export the per-second series as CSV for a chart:

```sh
jq -r '["timestamp","scenario","phase","concurrency","rps","p50_ms","p95_ms","p99_ms","errors"], (.series[] | [.timestamp,.scenario,.phase,.concurrency,.rps,.responseTimeMs.p50,.responseTimeMs.p95,.responseTimeMs.p99,.errors]) | @csv' load-test/results/smoke.json > load-test/results/smoke.csv
```
