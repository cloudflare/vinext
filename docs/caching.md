# Caching

Vinext supports several caching setups on Cloudflare. Caching is optional: if you do not enable it, your app still works without a shared response or data cache.

## What Vinext caches

There are two main kinds of cache:

- **Response / CDN cache:** rendered HTML, RSC payloads, and other ISR responses.
- **Data cache:** cached `fetch` calls, `unstable_cache`, and functions marked with `"use cache"`.

`revalidatePath()` and `revalidateTag()` invalidate entries in the configured cache. A route that uses request-specific data such as cookies or headers is not added to the shared response cache.

Static files and browser caching are separate from these options. Cloudflare can cache built assets without enabling a vinext cache adapter.

## Options

| Setup                                | Response storage           | Data storage           | Best for                                                                           | Main trade-off                                                                                               |
| ------------------------------------ | -------------------------- | ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No persistent cache                  | In-memory                  | In-memory              | Dynamic apps and initial migrations                                                | Every request may need to render and fetch its data                                                          |
| Workers Response Store (recommended) | Workers Cache backed by R2 | Workers Response Store | Durable responses, SWR, cache warming, and one cache system for responses and data | Requires R2, a SQLite Durable Object, and either a separate cache Worker or extra bindings on the app Worker |
| Workers Cache + data cache           | Workers Cache              | Workers KV             | Fast edge responses using Cloudflare's native caches                               | Cached responses have no durable backing store, and a hit in one region does not guarantee a hit elsewhere   |
| Data cache                           | Workers KV                 | Workers KV             | A simple persistent cache without Workers Cache                                    | Requests still reach the Worker and KV is eventually consistent                                              |

When caching is enabled through `vinext init`, Workers Response Store is the default choice.

## Workers Response Store

Workers Response Store is the most complete and best supported option. Workers Cache serves hot responses, R2 provides a durable backing store, and a SQLite Durable Object tracks metadata and invalidation state. An edge miss can read the stored response from R2 instead of immediately rendering the route again.

It also handles the data cache, so it replaces both `cdnAdapter()` and `kvDataAdapter()`:

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter() });
```

Metadata sharding is available as an explicit scaling option:

```ts
vinext({ cache: responseStoreAdapter({ shards: 16 }) });
```

Each cache key remains strongly coordinated by one SQLite Durable Object. Tag/path refreshes and purges fan out across all shards. The option is disabled by default, and changing the count starts a new cache layout for the deployed Worker version.

The default service-binding mode keeps the cache service in a separate Worker. `vinext init` creates `wrangler.response-store.jsonc` alongside the application config and adds a deployment script:

```sh
pnpm run deploy:response-store
```

Then deploy the application using its normal deploy command. The Response Store only needs redeploying when its package or Wrangler configuration changes. New application versions can be deployed normally.

For a single-Worker deployment, you can also consider using self-contained mode:

```ts
vinext({ cache: responseStoreAdapter({ mode: "self-contained" }) });
```

This avoids a second Worker, but the application Worker owns the R2 bucket, Durable Object, and cache-enabled entrypoint, which may not be desired for some applications.

## Workers Cache and KV

The older split setup uses Workers Cache for rendered responses and Workers KV for cached data:

```ts
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

vinext({
  cache: {
    cdn: cdnAdapter(),
    data: kvDataAdapter(),
  },
});
```

Workers Cache can serve a response without rerunning the render stage. Middleware and request routing still run before vinext selects the cached response entrypoint.

This setup is fast when an entry is present at the edge, but Workers Cache is distributed rather than one globally shared cache. A response cached in one region may still miss in another. Tiered caching can reduce this duplication, but without a durable response store a regional miss or eviction can require another render. The KV data cache is also eventually consistent.

The Workers Cache adapter supports staged cache warming through the Cloudflare deploy command. Warming is less direct because Workers Cache admission is controlled by response headers rather than a programmatic `put` API. vinext must render and probe routes to build a cacheability manifest, then make requests to fill the cache; it cannot simply upload known responses into Workers Cache. HTML and RSC payloads also use separate cache entries, so warming needs separate HTTP requests to seed both.

## Middleware and response cache policy

Middleware runs above the cached response stage on every request, including cache hits, so it cannot change which stored response is selected.

When a CDN adapter is configured, the adapter owns the client-visible cache policy. It derives `Cache-Control` from the route's own policy and keeps its edge policy in a provider header that is stripped before the response reaches the client. A cacheable `Cache-Control` set by middleware is rewritten into that derived policy, so middleware values are not delivered as authored. A middleware policy that is already non-cacheable, such as `no-store` or `private`, is preserved verbatim.

vinext warns in development when middleware sets `Cache-Control`, an adapter provider policy header, `Cache-Tag`, or a custom `Vary` field while a CDN adapter is configured. Put the route policy on the route instead, using `export const revalidate`, `cacheLife`, or `"use cache"`.

`Vary` fields set by middleware reach the client, but middleware runs above the cache, so they cannot partition the stored response or influence which cached variant is selected.

## Host-based partitioning and custom Vary

Workers Cache keys a response by the target entrypoint, the path and query string, the Worker version, and `ctx.props`. The request host is not part of that key; `Vary` is the documented content-negotiation mechanism. See [Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/).

vinext's response stage adds an opaque `__vinext_cache_key` to the cache-facing URL, derived from the full stage identity, which includes the request URL. Because the URL includes the hostname, the same path requested on different hostnames is stored and served separately. Multi-host and white-label deployments are therefore partitioned per hostname without `Vary: Host`, and keying on `x-forwarded-host` is not required.

Workers Cache honors the fields a cached response lists in `Vary`, but all variants of one URL share a single purge identity and must carry identical `Cache-Tag` values; see [Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/). vinext fails closed when the response stage cannot prove that tag invariance: a response that carries `Cache-Tag` and lists any non-framework `Vary` field is served with `Cache-Control: no-store` instead of being cached, and the response stage logs a warning when it does that.

In practice:

- Partition cached content with the path or the query string, or deploy a separate Worker per hostname.
- Do not expect `Vary` on a cached route response to partition it.
- `revalidateTag()` and `revalidatePath()` purge every variant of a URL together.

## KV data cache

You can use Workers KV without Workers Cache:

```ts
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

vinext({
  cache: {
    data: kvDataAdapter(),
  },
});
```

Add the matching namespace to `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<your-namespace-id>" }],
}
```

This is the smallest persistent setup. The same data cache can hold ISR responses and nested cached data, but every lookup goes through the application Worker and KV's eventual consistency may briefly expose older values after an update.

## Which option should I choose?

- Choose **no persistent cache** while migrating an app or when every response is intentionally dynamic.
- Choose **Workers Response Store (recommended)** for the most complete Cloudflare caching setup and durable response storage.
- Choose **Workers Cache + KV** when you specifically want the existing native Workers Cache architecture and accept that responses have no backing store.
- Choose **KV only** when you want the simplest persistent cache and do not need Workers Cache to serve responses.

You can run `vinext init --platform=cloudflare` to configure these choices. The generated Vite and Wrangler files are normal source files and can be adjusted later.

## Freshness and revalidation

vinext follows Next.js-style cache semantics:

- A **fresh** entry is returned immediately.
- A **stale** entry may be returned while stale-while-revalidate refreshes it in the background.
- An **expired** entry is not returned and must be regenerated.
- `revalidatePath()` invalidates content associated with a path.
- `revalidateTag()` invalidates content associated with a cache tag.

The adapter changes where entries live and how they are served, but it should not change the caching API used by application code.
