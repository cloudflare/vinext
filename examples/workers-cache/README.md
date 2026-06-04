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
import { cdnAdapter } from "vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "vinext/cloudflare/cache/kv-data-adapter";

vinext({
  cache: {
    cdn: cdnAdapter(),
    data: kvDataAdapter(), // binding defaults to VINEXT_KV_CACHE
  },
});
```

The Workers Cache only exposes `ctx.cache` when `cache.enabled: true` is set
in `wrangler.jsonc`, and the KV adapter needs a matching `VINEXT_KV_CACHE`
namespace binding — both are configured there.

## What's in the box

- ISR-cached App Router page at `/cached/[slug]` (`revalidate = 60`).
- Cached App Route handler at `/api/now` (`revalidate = 30`).
- Force-dynamic comparison page at `/dynamic`.
- Revalidation API at `/api/revalidate-tag` and `/api/revalidate-path` that
  drives the UI's "Invalidate this page" controls.
- A client-side **probe** that issues a no-store fetch against a route and
  prints the headers Cloudflare's edge attaches —
  [`cf-cache-status`](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#cloudflare-cache-responses)
  (the outer Workers Cache verdict), `Age`, plus the `Cache-Control` /
  `Cache-Tag` headers vinext emits to drive it.

## How vinext wires it up

1. **`vite.config.ts`** declares the adapters via `vinext({ cache })` (see
   above). The descriptors are plain serializable values — they don't touch
   the Workers runtime at build/dev time; the adapters instantiate lazily on
   the first request.

2. **`wrangler.jsonc`** enables the platform cache and binds the KV namespace:

   ```jsonc
   {
     "cache": { "enabled": true },
     "kv_namespaces": [
       { "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }
     ]
   }
   ```

   Create the namespace with `npx wrangler kv namespace create VINEXT_KV_CACHE`
   and drop the returned id in.

3. **The Worker entry** just delegates to the vinext App Router handler:

   ```ts
   import handler from "vinext/server/app-router-entry";
   export default { fetch: handler.fetch };
   ```

   The handler registers the configured adapters on the first request —
   passing the Worker's `env` so `kvDataAdapter()` can resolve its KV binding —
   then threads the request's `ExecutionContext` through ALS so `cdnAdapter()`
   can reach `ctx.cache` at revalidation time. No manual registration.

4. **ISR responses** carry `CDN-Cache-Control: public, max-age=N,
   stale-while-revalidate=M` (for the edge) plus a browser-facing
   `Cache-Control: public, max-age=0, must-revalidate`, and a `Cache-Tag`
   header listing both the bare path (`/cached/intro`) and Next.js's internal
   `_N_T_<path>` form. The Workers Cache reads these to cache and tag-purge.

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
> only runs on Cloudflare's edge — locally the `CDN-Cache-Control` /
> `Cache-Tag` headers `cdnAdapter()` emits are what drive it once deployed.

## Deploying

```sh
pnpm build
npx wrangler deploy
```
