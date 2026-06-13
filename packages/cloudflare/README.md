# @vinext/cloudflare

Cloudflare cache adapters for [vinext](https://www.npmjs.com/package/vinext).

This package provides the Cloudflare-specific cache backends that vinext uses for
ISR and the `"use cache"` data cache when deploying to Cloudflare Workers:

- **`kvDataAdapter()`** (`@vinext/cloudflare/cache/kv-data-adapter`) — backs the
  data cache (`fetch`, `"use cache"`, `unstable_cache`) with a Workers KV
  namespace. Also used for ISR in the absence of a cdn adapter.

## Usage

Declare the adapters on the `vinext()` plugin in your Vite config:

```ts
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        data: kvDataAdapter(), // KV-backed data cache (binding: VINEXT_KV_CACHE)
      },
    }),
    cloudflare(),
  ],
});
```
