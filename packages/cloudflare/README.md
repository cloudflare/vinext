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

### Workers Response Store

`responseStoreAdapter()` replaces both `cdnAdapter()` and `kvDataAdapter()`.
It defaults to a separate cache Worker reached through the `RESPONSE_STORE`
service binding. `vinext init` writes two collocated source configs:
`wrangler.jsonc` for the application and `wrangler.response-store.jsonc` for the
cache Worker. The latter points directly at the installed
`@cloudflare/workers-response-store` implementation and owns its R2 bucket,
SQLite Durable Object, Worker name, and cache settings. Edit those configs to
choose or reuse names, keeping the application service binding aligned with the
cache Worker name.

The two Workers are deliberately deployed separately. Deploy the Response Store
when its package or config changes, then deploy the application normally:

```sh
npx wrangler deploy --config wrangler.response-store.jsonc
npx @vinext/cloudflare deploy
```

`vinext-cloudflare deploy` never creates, rewrites, or deploys the Response
Store Worker.

To deploy storage and cache entrypoints with the application instead, select
self-contained mode:

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter({ mode: "self-contained" }) });
```

In this mode `vinext init` places the required R2, SQLite Durable Object,
Workers Cache entrypoint, and version-metadata configuration in
`wrangler.jsonc`; no second Wrangler config is required.

## Deploy

Deploy Cloudflare Workers projects with the package CLI:

```sh
npx @vinext/cloudflare deploy
```

Projects with `cloudflare.config.ts` opt into the experimental Cloudflare Vite
plugin v2 path and deploy their generated Build Output with `cf`. Existing
Wrangler-configured projects continue to use Wrangler. A normal typed-config
deploy does not need `wrangler.jsonc`.

Named auxiliary Workers in Build Output are deployed with `cf` before the entry
Worker. This currently requires vinext to project each auxiliary Worker as the
default Build Output for a separate `cf deploy --prebuilt`, because `cf@0.10.0`
only deploys the default Worker. The generated `cloudflare.config.ts` remains
the source of truth; no auxiliary Wrangler config is required.

Experimental staged CDN warming is currently a hybrid flow: `cf` builds and
uploads the Worker version, while Wrangler reads deployment status, stages and
promotes traffic, and applies triggers when needed. Until `cf` supports those
control-plane operations, warming also needs an equivalent Wrangler config for
trigger and version-metadata configuration. This is an alternative path for
trying `cf`, not a replacement for vinext's default Wrangler deployment path.

With Vite+, use `vpx @vinext/cloudflare deploy`, or
`vp exec vinext-cloudflare deploy` when running the locally installed bin.
