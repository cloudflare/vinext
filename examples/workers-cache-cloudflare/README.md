# Request-context cache demo

vinext supports route-level caching through whatever cache the runtime
exposes on the per-request `ctx` object. When the ExecutionContext has a
`ctx.cache.purge({ tags })` method, vinext automatically forwards
`revalidateTag()` / `revalidatePath()` invalidations to it alongside the
inner `CacheHandler`. There is **no runtime-specific module to import** —
if `ctx.cache` is there, it gets used; if not, nothing happens.

This example wires that up on Cloudflare Workers, where the platform
exposes the binding when `cache.enabled: true` is set in `wrangler.jsonc`.

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

1. **`wrangler.jsonc`** enables the platform-managed cache:

   ```jsonc
   {
     "cache": { "enabled": true }
   }
   ```

2. **The Worker entry** just delegates to the vinext App Router handler:

   ```ts
   import handler from "vinext/server/app-router-entry";
   export default { fetch: handler.fetch };
   ```

   vinext threads the request's `ExecutionContext` through ALS and inspects
   `ctx.cache` at revalidation time — no extra wiring or registration.

3. **ISR responses** carry `Cache-Control: s-maxage=N, stale-while-revalidate=M`
   and a `Cache-Tag` header listing both the bare path (`/cached/intro`)
   and Next.js's internal `_N_T_<path>` form. Any HTTP cache that reads
   those headers (including Cloudflare's Workers Cache) will cache the
   response correctly.

4. **`revalidateTag` / `revalidatePath`** in your route handlers fan out
   to both the inner CacheHandler (KV or memory) and `ctx.cache.purge(...)`
   on the platform layer.

## Running locally

```sh
pnpm install
pnpm dev
```

Then open http://localhost:5173 and click into any of the demo routes.

> **Note:** the platform-managed cache layer only runs on Cloudflare's
> edge. Locally you'll see vinext's inner cache (memory in dev) doing all
> the work; the `Cache-Control` and `Cache-Tag` headers it emits are what
> makes the outer layer work once deployed.

## Deploying

```sh
pnpm build
npx wrangler deploy
```
