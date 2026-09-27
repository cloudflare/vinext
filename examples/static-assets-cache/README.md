# Static Assets cache

An App Router application that serves its prerendered routes from Workers Static Assets through `staticAssetsAdapter()`.

`vite build` prerenders the static routes in Node, then packages their HTML, RSC payloads, and cached metadata responses into `.cloudflare/output/v0/workers/default/assets/_vinext/static-cache`. At runtime the Worker reads those entries through its `ASSETS` binding and returns them as cache hits (`X-Vinext-Cache: HIT`). Routes that were not prerendered keep rendering in the Worker.

## Run it

```sh
pnpm build    # vite build
pnpm start    # vite preview
pnpm deploy   # vinext-cloudflare deploy through cf
```

Both `vite build` and `vinext-cloudflare deploy` package prerendered routes into Static Assets.

## Routes

| Route           | Behavior                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `/`, `/about`   | Prerendered. HTML and RSC are Static Assets cache hits, rendered at build time. |
| `/posts/[slug]` | `generateStaticParams` paths, prerendered and served as cache hits.             |
| `/robots.txt`   | Cached metadata route, prerendered and served as a cache hit.                   |
| `/dynamic`      | `force-dynamic`. Rendered by the Worker on every request.                       |
| `/api/ping`     | Route handler. Runs in the Worker on every request.                             |

Every page shows where it was rendered. `build-time` means the response came from the packaged prerender, not from the Worker. The layout also imports `cloudflare:workers`, which checks that the Node prerender can load a Worker bundle using native Worker modules.

## Cloudflare config

The cache entries live inside the deployed assets directory. `cloudflare.config.ts` declares the `ASSETS` binding and routes `/_vinext/static-cache/*` to the Worker with `runWorkerFirst`. The Vite plugin selects the built client output as the assets directory. Without this rule, Workers Static Assets would serve the raw entries directly, skipping the Worker and any middleware.

The cache is read-only. `revalidatePath()` and `revalidateTag()` do not change it; deploying a new build replaces it.
