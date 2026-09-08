# Workers Cache demo

vinext ships two Cloudflare cache adapters you declare in `vite.config.ts`:

- **`cdnAdapter()`** serves page-level ISR through the **Cloudflare Workers
  Cache** (`ctx.cache`). The origin renders fresh and the edge absorbs
  HIT/STALE traffic, revalidating in the background; `revalidateTag()` /
  `revalidatePath()` fan out to `ctx.cache.purge({ tags })`.
- **`kvDataAdapter()`** backs the inner `"use cache"` / fetch data cache with
  a **Workers KV** namespace instead of in-memory.

Both are wired up in [`vite.config.ts`](./vite.config.ts):

```ts
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

vinext({
  cache: {
    cdn: cdnAdapter(),
    data: kvDataAdapter(), // binding defaults to VINEXT_KV_CACHE
  },
});
```

`cdnAdapter()` generates the per-entrypoint Workers Cache configuration during
the Cloudflare build. The KV adapter still needs a matching
`VINEXT_KV_CACHE` namespace binding in `wrangler.jsonc`.

The adapter adds a transport-only URL digest so distinct response-stage
identities cannot collide. Workers Cache owns this key independently of zone
Cache Rules.

## What's in the box

- ISR-cached App Router page at `/cached/[slug]` (`revalidate = 60`).
- Cached App Route handler at `/api/now` (`revalidate = 30`).
- Late-dynamic personalized comparison page at `/dynamic`.
- Revalidation API at `/api/revalidate-tag` and `/api/revalidate-path` that
  drives the UI's "Invalidate this page" controls.
- A client-side **probe** that issues a no-store fetch against a route and
  prints the headers Cloudflare's edge attaches —
  [`cf-cache-status`](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#cloudflare-cache-responses)
  (the cache-enabled response entrypoint's verdict), `Age`, and the public
  browser `Cache-Control` policy.

## How vinext wires it up

1. **`vite.config.ts`** declares the adapters via `vinext({ cache })` (see
   above). The declarations do not touch the Workers runtime during config
   evaluation. The Cloudflare build hook emits the staged Worker configuration,
   and runtime adapters instantiate lazily on the first request.

2. **`wrangler.jsonc`** binds the KV namespace:

   ```jsonc
   {
     "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }],
   }
   ```

   Create the namespace with `npx wrangler kv namespace create VINEXT_KV_CACHE`
   and drop the returned id in.

3. **The Worker entry** uses vinext's router-selected handler directly from
   `wrangler.jsonc`:

   ```jsonc
   {
     "main": "vinext/server/fetch-handler",
   }
   ```

   When `cdnAdapter()` is configured, vinext asks the Cloudflare build for two
   Worker entrypoints. The default entrypoint runs routing and middleware with
   caching disabled; `VinextCachedResponse` lazily loads the render stage with
   Workers Cache enabled. The generated `dist/server/wrangler.json` contains
   those settings, so existing applications do not need a source-config edit.
   The handler also passes the Worker's `env` so `kvDataAdapter()` can resolve
   its KV binding. No manual registration.

4. **The inner cached response** carries `Cloudflare-CDN-Cache-Control: public,
   max-age=N, stale-while-revalidate=M` plus a `Cache-Tag` containing
   Cloudflare-safe fixed-size digests of both the bare path (`/cached/intro`)
   and Next.js's internal `_N_T_<path>` form. Workers Cache consumes those
   private headers for admission and tag purging. The uncached gateway removes
   them before public egress and returns the browser-facing `Cache-Control:
   private, max-age=0, must-revalidate` policy. Because Workers Cache requires
   every `Vary` variant of a URL to use the same cache tags, vinext
   conservatively leaves a tagged response uncached when the rendered response
   declares an application-defined `Vary` field; use a separate URL or
   response-stage identity when those variants need both caching and tag
   invalidation.

5. **`revalidateTag` / `revalidatePath`** in your route handlers fan out to
   both the KV data cache and `ctx.cache.purge(...)` on the platform layer.

## Running locally

```sh
pnpm install
pnpm dev
```

Then open http://localhost:5173 and click into any of the demo routes.

> **Note:** dev runs on `@cloudflare/vite-plugin` (miniflare), so the
> `VINEXT_KV_CACHE` namespace is emulated locally and `kvDataAdapter()`
> works. The edge CDN layer (`cf-cache-status`, background revalidation)
> only runs on Cloudflare's edge. Local development may expose the inner
> `Cloudflare-CDN-Cache-Control` / `Cache-Tag` policy directly because it does
> not pass through the deployed multi-entrypoint gateway.

## Deploying

```sh
pnpm build
npx wrangler deploy
```
