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
render stage with Workers Cache enabled. Legacy Cloudflare Vite plugin builds
write these settings and the version metadata binding to the generated
`dist/server/wrangler.json`.

```ts
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

vinext({ cache: { cdn: cdnAdapter() } });
```

Cloudflare Vite plugin v2 uses Build Output and treats `cloudflare.config.ts`
as the deployment source of truth. Declare the equivalent policies there:

```ts
import {
  bindings,
  defineWorker,
  exports as workerExports,
} from "@cloudflare/vite-plugin/experimental-config";

export default defineWorker({
  // ...
  cache: { enabled: false },
  env: {
    CF_VERSION_METADATA: bindings.versionMetadata(),
  },
  exports: {
    VinextCachedResponse: workerExports.worker({ cache: { enabled: true } }),
    VinextUncachedResponse: workerExports.worker({ cache: { enabled: false } }),
  },
});
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

## Deploy

Deploy Cloudflare Workers projects with the package CLI:

```sh
npx @vinext/cloudflare deploy
```

Projects with `cloudflare.config.ts` opt into the experimental Cloudflare Vite
plugin v2 path and deploy their generated Build Output with `cf`. Existing
Wrangler-configured projects continue to use Wrangler. A normal typed-config
deploy does not need `wrangler.jsonc`.

Experimental staged CDN warming is currently a hybrid flow: `cf` builds and
uploads the Worker version, while Wrangler reads deployment status, stages and
promotes traffic, and applies triggers when needed. Until `cf` supports those
control-plane operations, warming also needs an equivalent Wrangler config for
trigger and version-metadata configuration. This is an alternative path for
trying `cf`, not a replacement for vinext's default Wrangler deployment path.

With Vite+, use `vpx @vinext/cloudflare deploy`, or
`vp exec vinext-cloudflare deploy` when running the locally installed bin.
