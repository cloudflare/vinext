# @vinext/cloudflare

Cloudflare cache adapters for [vinext](https://www.npmjs.com/package/vinext).

This package provides the Cloudflare-specific cache backends that vinext uses for
ISR and the `"use cache"` data cache when deploying to Cloudflare Workers:

- **`kvDataAdapter()`** (`@vinext/cloudflare/cache/kv-data-adapter`) — backs the
  data cache (`fetch`, `"use cache"`, `unstable_cache`) with a Workers KV
  namespace. Exposes `KVCacheHandler` for imperative use.
- **`cdnAdapter()`** (`@vinext/cloudflare/cache/cdn-adapter`) — backs
  full-route, edge-managed page-level ISR with the Workers Cache API.

## Usage

Declare the adapters on the `vinext()` plugin in your Vite config:

```ts
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        data: kvDataAdapter(), // KV-backed data cache (binding: VINEXT_KV_CACHE)
        cdn: cdnAdapter(), // optional: edge-managed page-level ISR
      },
    }),
    cloudflare(),
  ],
});
```

Or wire a handler imperatively from a worker entry:

```ts
import { KVCacheHandler } from "@vinext/cloudflare";
import { setDataCacheHandler } from "vinext/shims/cache";

setDataCacheHandler(new KVCacheHandler(env.VINEXT_KV_CACHE));
```
