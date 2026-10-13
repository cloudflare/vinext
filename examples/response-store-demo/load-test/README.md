# Workers Response Store load test

This isolated App Router app supports four load modes:

- `lifecycle` uses `/cacheable/:id` with 15 seconds of freshness and a 15-second SWR window, then verifies the
  transition from `MISS` to stored `HIT`, stale `UPDATING`, and a recovered `HIT` with a new render
  token. It also requests `/dynamic/:id` twice and verifies that a `no-store` response is not
  retained. This is the default mode.
- `miss` repeatedly requests nonexistent 404 URLs. The responses cannot be stored, so each request
  performs a metadata lookup without an R2 body read or write.
- `dynamic` repeatedly requests force-dynamic URLs to exercise metadata misses plus application
  rendering.
- `fill` requests a unique cacheable URL each time, exercising metadata lookup, application
  rendering, R2 body writes, SQLite publication, and Workers Cache admission.

The dependency-free runner writes chart-ready per-second RPS, response-time percentiles, cache
states, errors, and lifecycle summaries to `results/*.json`.

The app opts into 16 metadata shards with `responseStoreAdapter({ shards: 16 })`; the cache Worker
configuration itself is unchanged because shard routing is carried by each application-version
invocation.

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

For a full run that completely fills concurrency levels 400 through 2,000, disable WARP and run
from this directory:

```sh
node load.mjs --base-url https://vinext-response-store-load-test.vinext.workers.dev --cacheable 6000 --dynamic 6000 --concurrency 400,800,1200,1600,2000 --timeout-ms 30000
```

The report records the `cdn-cgi/trace` network state and retains the complete first non-200 response
and nested first network error. Re-enable WARP after the command finishes; the runner prints the
timestamped `results/*.json` path to hand off.

Available options are `--base-url`, `--cacheable`, `--dynamic`, `--concurrency`, `--timeout-ms`,
`--output`, `--mode`, `--requests`, `--rps`, `--max-concurrency`, `--stage-seconds`,
`--stage-pause-seconds`, and `--keys`. `--concurrency` accepts a comma-separated progression such
as `50,100,200`. `--cacheable` and `--dynamic` configure lifecycle mode. Throughput modes (`miss`,
`dynamic`, and `fill`) use `--requests` as their total by default; pass one comma-separated
`--stage-seconds` duration per concurrency level to run duration-controlled stages instead.
Alternatively, pair `--rps` with `--stage-seconds` for an open-loop request-rate ramp;
`--max-concurrency` caps outstanding foreground requests and `--stage-pause-seconds` lets
background admissions drain between stages.
`LOAD_TEST_BASE_URL` may be used instead of `--base-url`.

Miss and dynamic modes use one repeated key by default, targeting one metadata shard. Increase
`--keys` to spread requests across the configured shards. For example, this drives one never-stored
404 key through progressively higher concurrency. Each completed request corresponds to one
metadata `getEntry` RPC, so achieved request RPS is the Durable Object RPC rate for this mode:

```sh
node load.mjs --mode miss --requests 72000 --keys 1 --concurrency 50,100,200,400,800,1200,1600,2000 --base-url https://vinext-response-store-load-test.vinext.workers.dev --output results/miss-ramp.json
```

Use the same progression with application rendering included:

```sh
node load.mjs --mode dynamic --requests 72000 --keys 1 --concurrency 50,100,200,400,800,1200,1600,2000 --base-url https://vinext-response-store-load-test.vinext.workers.dev --output results/dynamic-ramp.json
```

Use `fill` to create a unique cache entry per request and load the complete R2 and SQLite write
path:

```sh
node load.mjs --mode fill --requests 50000 --concurrency 100,200,400,800,1200 --base-url https://vinext-response-store-load-test.vinext.workers.dev --output results/fill-ramp.json
```

To locate the R2/SQLite admission threshold without allowing foreground concurrency to determine
the offered rate, gradually ramp RPS and pause between stages:

```sh
node load.mjs \
  --mode fill \
  --rps 250,500,750,1000,1250,1500,1750,2000,2500,3000,3500,4000,5000 \
  --stage-seconds 20,20,20,20,20,20,20,20,20,20,20,20,120 \
  --stage-pause-seconds 30 \
  --max-concurrency 2000 \
  --timeout-ms 30000 \
  --base-url https://vinext-response-store-load-test.vinext.workers.dev \
  --output results/fill-rps-ramp.json
```

To ramp beyond 2,000 concurrent requests and hold the maximum for a full minute, use short
duration-controlled ramp stages followed by a 60-second final stage:

```sh
node load.mjs \
  --mode miss \
  --keys 256 \
  --concurrency 400,800,1200,1600,2000,2400,2800,3200,4000 \
  --stage-seconds 5,5,5,5,5,5,5,5,60 \
  --timeout-ms 30000 \
  --base-url https://vinext-response-store-load-test.vinext.workers.dev \
  --output results/sharded-miss-ramp-hold.json
```

The runner starts new requests at the selected concurrency until each stage duration expires,
then drains its in-flight requests before advancing. `stages[].targetDurationSeconds` records the
requested active duration; `stages[].durationSeconds` includes the final drain. Duration-controlled
runs complete every requested stage even when responses fail, ensuring the final hold still runs.

Request-count runs stop after a stage exceeds a 1% failure rate. Every run exits non-zero if any
request or lifecycle failed.

## Read the JSON output

- `series` contains one point per second and phase, including RPS, latency percentiles, status
  codes, cache states, errors, and the requested `targetRps` when rate-controlled. Use `timestamp`
  as the line-chart x-axis.
- `stages` records full-stage duration, achieved RPS, response-time percentiles, statuses, and
  success totals for each throughput level. Rate-controlled stages also record `targetRps` and
  `offeredRps`, making it visible when the foreground concurrency cap cannot sustain the target.
- `summaries` aggregates those measurements by scenario, phase, and concurrency.
- `lifecycle` reports attempted, successful, and failed cacheable and dynamic lifecycles.
- `transitionTimeMs` reports cache admission and SWR recovery latency.
- `metadata` records the target, client, git revision, run ID, and optional deployed Worker version
  IDs, plus the WARP/Gateway state reported by `cdn-cgi/trace`.
- `diagnostics` retains the complete first HTTP error and nested first network error, when present.

## Diagnose the client network path

`network-burst.mjs` sends 600 concurrent cold requests by default and writes a smaller timestamped
report:

```sh
node network-burst.mjs
```

Its optional arguments are `--requests`, `--base-url`, `--timeout-ms`, and `--output`. For example:

```sh
node network-burst.mjs --requests 1000 --timeout-ms 30000 --output results/network-burst-1000.json
```

Results are intentionally ignored by git. To export the per-second series as CSV for a chart:

```sh
jq -r '["timestamp","scenario","phase","concurrency","rps","p50_ms","p95_ms","p99_ms","errors"], (.series[] | [.timestamp,.scenario,.phase,.concurrency,.rps,.responseTimeMs.p50,.responseTimeMs.p95,.responseTimeMs.p99,.errors]) | @csv' load-test/results/smoke.json > load-test/results/smoke.csv
```
