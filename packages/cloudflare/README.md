# @vinext/cloudflare

Cloudflare deployment tools and runtime adapters for
[vinext](https://www.npmjs.com/package/vinext).

This package provides Cloudflare-specific cache and image backends for vinext:

- **`kvDataAdapter()`** (`@vinext/cloudflare/cache/kv-data-adapter`) — backs the
  data cache (`fetch`, `"use cache"`, `unstable_cache`) with a Workers KV
  namespace.
- **`cdnAdapter()`** (`@vinext/cloudflare/cache/cdn-adapter`) — delegates
  page-level ISR serving and revalidation to Cloudflare Workers Cache through
  an automatically generated cache-enabled response entrypoint.
- **`responseStoreAdapter()`** (`@vinext/cloudflare/cache/response-store-adapter`) —
  uses Workers Response Store for both response and data caching, either in a
  separate cache Worker or inside the application Worker.
- **`imagesOptimizer()`** (`@vinext/cloudflare/images/images-optimizer`) — backs
  `next/image` transformations with a Cloudflare Images binding.

## Usage

Declare the adapters on the `vinext()` plugin in your Vite config:

```ts
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        data: kvDataAdapter(), // KV-backed data cache (binding: VINEXT_KV_CACHE)
      },
      images: { optimizer: imagesOptimizer() }, // Cloudflare Images binding: IMAGES
    }),
    cloudflare(),
  ],
});
```

### Workers Cache

`cdnAdapter()` is optional. Configuring it asks the Cloudflare build for two
Worker entrypoints: the default entrypoint runs middleware and request-time
routing with caching disabled, while `VinextCachedResponse` lazily loads the
render stage with Workers Cache enabled. These settings are written to the
generated `dist/server/wrangler.json`; do not enable Workers Cache on the
default entrypoint in your source config. The generated config also declares
the version metadata binding used for staged warmup.

```ts
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

vinext({ cache: { cdn: cdnAdapter() } });
```

The generated version metadata binding lets staged warmup prove that every
discovery, probe, and fill request reached the uploaded Worker version. Pass
`versionMetadataBinding` to `cdnAdapter()` only when the deployment needs a
custom binding name.

Use `--experimental-warm-cdn-cache` for the two-stage deploy. The default flow
makes one final fill request per admitted identity. Add `--warm-cdn-certify`
only when you want an opt-in second, header-only request that must prove every
planned entry reusable before promotion.

The response entrypoint hashes the complete transport identity into its
Workers Cache URL, independently of zone Cache Rules, so distinct query and
representation variants cannot collide.

### Workers Response Store

`responseStoreAdapter()` replaces both `cdnAdapter()` and `kvDataAdapter()`.
It defaults to a separate cache Worker reached through the `RESPONSE_STORE`
service binding. To deploy storage and cache entrypoints with the application
instead, select self-contained mode:

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter({ mode: "self-contained" }) });
```

Self-contained Workers must bind `CACHE_BODIES` to R2, bind the SQLite
`CacheMetadata` Durable Object as `CACHE_METADATA`, export
`ResponseStoreBinding` with Workers Cache enabled, and include the
`CF_VERSION_METADATA` version-metadata binding. The default Worker entrypoint
must keep Workers Cache disabled. This removes the cache Worker and service
binding without changing cache behavior or the application API.

## Deploy

Deploy Cloudflare Workers projects with the package CLI:

```sh
npx @vinext/cloudflare deploy
```

With Vite+, use `vpx @vinext/cloudflare deploy`, or
`vp exec vinext-cloudflare deploy` when running the locally installed bin.
