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
import { defineWorker } from "@cloudflare/vite-plugin/experimental-config";
import { createWorkersCacheConfig } from "@vinext/cloudflare/cache/config";

const workersCache = await createWorkersCacheConfig();

export default defineWorker({
  // ...
  ...workersCache,
  env: {
    ...workersCache.env,
    // Other application bindings...
  },
});
```

The generated version metadata binding lets staged warmup prove that every
discovery, probe, and fill request reached the uploaded Worker version. Pass
the same `versionMetadataBinding` to `cdnAdapter()` and
`createWorkersCacheConfig()` only when the deployment needs a custom binding
name.

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

Cloudflare Vite plugin v2 projects can define the same service-binding setup in
`cloudflare.config.ts` without a second Wrangler config:

```ts
import { defineConfig, defineWorker } from "@cloudflare/vite-plugin/experimental-config";
import { createWorkersResponseStoreServiceBindingConfig } from "@vinext/cloudflare/cache/config";

const responseStore = await createWorkersResponseStoreServiceBindingConfig({
  worker: {
    name: "example-response-store",
    compatibilityDate: "2026-09-15",
    compatibilityFlags: ["nodejs_compat"],
  },
  bucket: "example-response-store-cache-bodies",
});

export const responseStoreServiceBinding = responseStore.serviceBindingWorker;

export default defineConfig({
  worker: defineWorker({
    ...responseStore.applicationWorker,
    name: "example",
    entrypoint: "./worker.ts",
  }),
});
```

The async config helpers import bindings and exports from your installed
`@cloudflare/vite-plugin/experimental-config`. The plugin is an optional peer
dependency of `@vinext/cloudflare`; these helpers require v2, but Wrangler-only
projects do not need it.

Register the exported auxiliary Worker with the Cloudflare Vite plugin so it
is built alongside the application:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { responseStoreServiceBinding } from "./cloudflare.config.ts";

cloudflare({ auxiliaryWorkers: [{ config: responseStoreServiceBinding }] });
```

Metadata sharding is opt-in and works in either deployment mode:

```ts
vinext({ cache: responseStoreAdapter({ shards: 16 }) });
```

Keys remain pinned to one shard while tag/path mutations fan out across every
shard. Omit `shards` to retain the original single metadata Durable Object.

To place newly created metadata Durable Objects near a stable traffic and R2
region, pass a Cloudflare location hint:

```ts
vinext({ cache: responseStoreAdapter({ locationHint: "weur" }) });
```

The hint works in both deployment modes, is best-effort, and only affects each
Durable Object's first creation. Changing it does not relocate existing
objects; treat the change as a cache-cold deployment and align it with the R2
bucket's location.

To deploy storage and cache entrypoints with the application instead, select
self-contained mode:

```ts
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";

vinext({ cache: responseStoreAdapter({ mode: "self-contained" }) });
```

The corresponding typed config helper is
`createWorkersResponseStoreSelfContainedConfig`.

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
deploy needs neither `wrangler.jsonc` nor the Wrangler package.

`vinext-cloudflare deploy` only deploys the entry Worker. It never deploys named
auxiliary Workers, including during staged warming or `--no-promote` uploads.
Deploy a configured Response Store Worker explicitly after building, when first
setting it up or when its code/config changes:

```sh
cf deploy --prebuilt --mode production --worker example-response-store
```

Use the mode and Worker name from your build. `cloudflare.config.ts` remains the
source of truth; no auxiliary Wrangler config is required.

Experimental staged CDN warming uses `cf` to upload a version, read deployment
status, stage and promote traffic, and apply triggers. Typed-config projects do
not need an equivalent Wrangler config. Existing Wrangler-configured projects
continue to use Wrangler for this flow.

With Vite+, use `vpx @vinext/cloudflare deploy`, or
`vp exec vinext-cloudflare deploy` when running the locally installed bin.
