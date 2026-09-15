# Workers Response Store load test

This isolated vinext app exercises two production Response Store paths:

- A cacheable Pages Router response uses five seconds of freshness and a fifteen-second SWR
  window, then transitions through `MISS`, stored `HIT`, short-SWR
  `UPDATING`, and a final `HIT` with a new render token.
- A dynamic Pages Router response is requested twice at the same URL and must remain `no-store`
  with a different render token each time.

The dependency-free load runner writes chart-ready per-second RPS, response-time percentiles,
cache states, errors, and lifecycle summaries to `results/*.json`.

From `examples/response-store-demo`:

```sh
pnpm exec sh -c 'cd load-test && node ../../../packages/vinext/dist/cli.js build'
pnpm exec wrangler r2 bucket create vinext-response-store-load-test-bodies --location weur
pnpm exec wrangler deploy --config load-test/wrangler.response-store.jsonc
pnpm exec wrangler deploy --config load-test/dist/rsc/wrangler.json
pnpm exec sh -c 'cd load-test && GIT_SHA=$(git rev-parse HEAD) node load.mjs --base-url https://vinext-response-store-load-test.vinext.workers.dev'
```

Use smaller counts for a smoke run:

```sh
pnpm exec sh -c 'cd load-test && node load.mjs --base-url "$LOAD_TEST_BASE_URL" --cacheable 4 --dynamic 4 --concurrency 2'
```
