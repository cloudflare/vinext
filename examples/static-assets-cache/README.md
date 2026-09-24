# Static Assets cache

An App Router application that serves its prerendered routes from Workers Static Assets through `staticAssetsAdapter()`.

`vinext build` prerenders the static routes in Node, then packages their HTML, RSC payloads, and cached metadata responses into `dist/client/_vinext/static-cache`. At runtime the Worker reads those entries through its `ASSETS` binding and returns them as cache hits (`X-Vinext-Cache: HIT`). Routes that were not prerendered keep rendering in the Worker.

## Run it

```sh
pnpm build
pnpm preview
```

Use `vinext build` (the `build` script), not `vp build`: only the vinext CLI runs the prerender phase that fills the cache.

## Routes

| Route         | Behavior                                                                        |
| ------------- | ------------------------------------------------------------------------------- |
| `/`, `/about` | Prerendered. HTML and RSC are Static Assets cache hits, rendered at build time. |
| `/robots.txt` | Cached metadata route, prerendered and served as a cache hit.                   |
| `/dynamic`    | `force-dynamic`. Rendered by the Worker on every request.                       |
| `/api/ping`   | Route handler. Runs in the Worker on every request.                             |

Every page shows where it was rendered. `build-time` means the response came from the packaged prerender, not from the Worker. The layout also imports `cloudflare:workers`, which checks that the Node prerender can load a Worker bundle using native Worker modules.

## Wrangler config

The cache entries live inside the deployed assets directory, so `wrangler.jsonc` routes `/_vinext/static-cache/*` to the Worker with `run_worker_first`. Without that, Workers Static Assets would serve the raw entries directly, and those requests would skip the Worker and any middleware.

The cache is read-only. `revalidatePath()` and `revalidateTag()` do not change it; deploying a new build replaces it.
