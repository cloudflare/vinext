# Workers Response Store

`@cloudflare/workers-response-store` is a framework-agnostic, programmatic response store for Cloudflare Workers. It combines Workers Cache for edge delivery, R2 for response bodies, and a SQLite Durable Object for strongly consistent metadata, revisions, and tag invalidation.

Use it to add persistent response caching, stale-while-revalidate (SWR), on-demand refresh, and purge APIs to a Worker or framework adapter. It supports either a dedicated cache Worker accessed through a service binding or a self-contained Worker deployment.

## Install

```sh
npm install @cloudflare/workers-response-store
```

The examples below use a current compatibility date, `nodejs_compat`, generated Wrangler types, and Workers observability. Create the configured R2 bucket before deploying, then run `wrangler types` after adding the bindings.

## Service-binding setup

Service-binding mode separates cache infrastructure from application code. It is useful for a standalone application as well as for multiple Workers: the cache Worker can be deployed and observed independently, storage bindings stay out of the application Worker, and the same cache service can be reused later without changing the integration API.

The cache Worker owns Workers Cache, R2, and a SQLite Durable Object. Each application Worker keeps its own regeneration callback and passes that version-pinned capability over RPC.

### Cache Worker

Point `main` at the installed service entrypoint:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "response-store",
  "main": "./node_modules/@cloudflare/workers-response-store/dist/service.js",
  "compatibility_date": "2026-09-16",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "cache": { "enabled": true },
  "exports": {
    "default": { "type": "worker", "cache": { "enabled": false } },
    "ResponseStoreBinding": { "type": "worker", "cache": { "enabled": true } },
    "CacheMetadata": { "type": "durable-object", "storage": "sqlite" },
  },
  "r2_buckets": [{ "binding": "CACHE_BODIES", "bucket_name": "my-response-bodies" }],
  "durable_objects": {
    "bindings": [{ "name": "CACHE_METADATA", "class_name": "CacheMetadata" }],
  },
  "observability": { "enabled": true },
}
```

`CacheMetadata` is a declarative SQLite Durable Object export. Do not also add it to Wrangler `migrations`.

### Application Worker

Bind the application to the uncached `ResponseStoreService` entrypoint and include version metadata:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-16",
  "compatibility_flags": ["nodejs_compat"],
  "services": [
    {
      "binding": "RESPONSE_STORE",
      "service": "response-store",
      "entrypoint": "ResponseStoreService",
    },
  ],
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "observability": { "enabled": true },
}
```

Create the client and export its generated entrypoints:

```ts
import { createWorkersResponseStoreClient } from "@cloudflare/workers-response-store";

const responseStore = createWorkersResponseStoreClient<Env>({
  regenerate(input, { env, ctx }) {
    return render(input.request, env, ctx, input);
  },
});

export const { ResponseStoreRevalidator, ResponseStoreClient } = responseStore.entrypoints;
```

The client exposes the same read, write, refresh, and purge methods as self-contained mode. There is no reverse service binding or circular deployment: deploy the cache Worker, then deploy the application Worker.

## Single-Worker setup

Single-Worker mode keeps the application, cache entrypoint, R2 bucket, and metadata Durable Object in one deployment. Choose it when one deployment and one Wrangler configuration are more useful than independently managed cache infrastructure.

### 1. Create and export the store

```ts
import { createWorkersResponseStore } from "@cloudflare/workers-response-store";

const responseStore = createWorkersResponseStore<Env>({
  regenerate(input, { env, ctx }) {
    return render(input.request, env, ctx, {
      id: input.id,
      args: input.args,
      reason: input.reason,
    });
  },
});

export const { CacheMetadata, ResponseStoreRevalidator, ResponseStoreBinding } =
  responseStore.entrypoints;
```

The named exports must match the Wrangler configuration. `regenerate` is called for SWR, expired entries, missing R2 bodies, and explicit refreshes. Give each stored response a serializable revalidator descriptor so the callback can reconstruct it later.

### 2. Read through and fill the store

```ts
function isResponseStoreMiss(response: Response): boolean {
  return response.status === 404 && response.headers.get("X-Workers-Response-Store") === "MISS";
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return render(request, env, ctx);
    }

    // Cache identity is pathname + query string. Use a canonical GET request
    // with only information that is safe to share between visitors.
    const cacheRequest = new Request(request.url);
    const cached = await responseStore.fetch(cacheRequest);
    if (!isResponseStoreMiss(cached)) {
      return cached;
    }

    const response = await render(request, env, ctx);
    await responseStore.put(cacheRequest, response.clone(), {
      revalidator: { id: "page", args: [] },
    });
    return response;
  },
} satisfies ExportedHandler<Env>;
```

This is the minimum integration loop. A framework can add its own cacheability rules, vary dimensions, streaming policy, error handling, and mapping from routes to revalidator IDs and arguments.

### 3. Configure Wrangler

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-16",
  "compatibility_flags": ["nodejs_compat"],
  "cache": { "enabled": true },
  "exports": {
    "default": { "type": "worker", "cache": { "enabled": false } },
    "ResponseStoreBinding": { "type": "worker", "cache": { "enabled": true } },
    "CacheMetadata": { "type": "durable-object", "storage": "sqlite" },
  },
  "r2_buckets": [{ "binding": "CACHE_BODIES", "bucket_name": "my-response-bodies" }],
  "durable_objects": {
    "bindings": [{ "name": "CACHE_METADATA", "class_name": "CacheMetadata" }],
  },
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "observability": { "enabled": true },
}
```

`CacheMetadata` is a declarative SQLite Durable Object export. Do not also add it to Wrangler `migrations`. Create the configured R2 bucket before deploying, then run `wrangler types` to generate `Env` from the completed configuration.

## API

The object returned by `createWorkersResponseStore()` and `createWorkersResponseStoreClient()` implements the same API:

| Method                                           | Behavior                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch(request)`                                 | Reads a canonical `GET` cache key. Returns a stored response or a `404` Response Store miss. Stale entries inside their SWR window return immediately and regenerate in the background; hard-expired entries wait for regeneration. |
| `put(request, response, options?)`               | Stores a response under a canonical `GET` cache key. `options.revalidator` supplies `{ id, args }` for future regeneration. Set `purgeExisting: true` when replacing an entry that may already be in Workers Cache.                 |
| `refresh({ tags, pathPrefixes })`                | Regenerates matching entries and purges their prior edge responses. At least one selector is required.                                                                                                                              |
| `purge({ tags, pathPrefixes, purgeEverything })` | Removes matching metadata, records tag invalidations, deletes response bodies, and purges corresponding edge responses. At least one selector or `purgeEverything: true` is required.                                               |
| `getTagExpiration(tags)`                         | Returns the latest invalidation timestamp for a set of framework-managed soft tags. Most integrations do not need this low-level method.                                                                                            |

Mutation methods return:

```ts
type ResponseStoreMutationResult = {
  backingStoreUpdated: boolean;
  edgePurgeAccepted: boolean;
};
```

### Cache keys

- Keys must be `GET` requests.
- Identity is the URL pathname plus query string; scheme and host are ignored.
- Every key stores its response and read metadata together in one version-scoped R2 object by default, so fresh hits and misses do not query the metadata Durable Object. No special key format is required.
- Build the key from trusted route and vary data. Do not include arbitrary visitor headers or other unbounded input unless it intentionally creates a distinct shared response.

### Freshness and tags

Freshness is derived from `Cloudflare-CDN-Cache-Control`, then `CDN-Cache-Control`, then `Cache-Control`. The store preserves an incoming `Age` value and advances it while the response is stored.

Set `Cache-Tag` on the response passed to `put()` to associate comma-separated purge tags. `refresh()` and `purge()` also accept pathname prefixes. Tags are matched case-insensitively for invalidation.

The `regenerate` callback receives the stored `id` and `args`, a canonical cache-key request, and one of these reasons:

| Reason    | Trigger                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `swr`     | A stale response was returned inside its SWR window.                    |
| `expired` | The response passed its SWR window and the read must wait.              |
| `missing` | The R2 object exists but its committed response content is unavailable. |
| `manual`  | `refresh()` selected the entry.                                         |

### Response headers

`fetch()` responses include these Response Store protocol headers:

| Header                                        | Value                                   | Meaning                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Workers-Response-Store`                    | `MISS`, `BLOB-FRESH`, or `BLOB-STALE`   | Whether metadata was absent or the R2 response was fresh or stale when the binding read it. A miss is a `404` with `Cache-Control: no-store`.                                                             |
| `X-Workers-Response-Store-Revision`           | Positive integer                        | The active stored revision returned to the caller. It is absent on a miss.                                                                                                                                |
| `X-Workers-Response-Store-Binding-Invocation` | UUID                                    | Identifies the binding invocation that loaded the response from R2. Workers Cache reuses the value from its cached fill, making it useful for diagnosing whether the binding ran. It is absent on a miss. |
| `X-Workers-Response-Store-Age-Basis`          | `<created-at-ms>:<initial-age-seconds>` | The response creation timestamp and its original `Age`. Calculate the current age as `initialAgeSeconds + max(0, floor((Date.now() - createdAtMs) / 1000))`.                                              |

These headers describe the Response Store binding result, not the current Workers Cache edge state; use `CF-Cache-Status` for the latter. An adapter may consume and remove protocol headers before returning an application response.

## Performance

Workers Cache hits bypass the Response Store binding Worker, R2, and every metadata Durable Object. The backing store and sharding path run only when Workers Cache invokes the binding for a miss or update.

### Metadata sharding

Metadata sharding is opt-in:

```ts
const responseStore = createWorkersResponseStore<Env>({
  shards: 16,
  regenerate,
});
```

`shards` must be an integer greater than one. Without it, all version-scoped metadata uses the original single Durable Object.

Each cache key and all its revisions, claims, and pending objects route to one deterministic shard. Refresh and purge fan out across every shard, while tag invalidation timestamps are replicated so publication fencing and soft-tag checks remain correct. Soft-tag reads select a stable replica to distribute load.

Changing the shard count selects a new metadata and R2 layout. Treat it as a cache-cold deployment change, not an in-place scaling control.

### Metadata location

Both deployment modes accept a Durable Object location hint:

```ts
const responseStore = createWorkersResponseStore<Env>({
  locationHint: "weur",
  regenerate,
});
```

Use the same `locationHint` option with `createWorkersResponseStoreClient()` in service-binding mode. The hint is best-effort and only affects the first creation of each metadata Durable Object. Existing objects never move when this option changes, so roll out a changed hint as a cache-cold deployment and choose it alongside the R2 bucket's location.

## Storage and operational behavior

```text
application Worker
  └─ ResponseStoreBinding (Workers Cache enabled)
       ├─ cache hit ───────────────► stored Response
       └─ cache miss
            ├─ response + read metadata ─► R2
            ├─ write coordination/revisions ─► SQLite Durable Object
            └─ regeneration ───────► application callback
```

- Responses use `runtime-cache/<version-id>/r2-v1/[shards-<count>/]<digest>/active`. The layout segment isolates this R2-backed implementation from older cache-Worker versions during service-binding rollbacks and rolling deployments.
- SQLite revisions and conditional publication prevent slow writes from replacing newer writes or resurrecting purged entries. User RPC, R2, and cache-purge I/O run outside SQLite transactions.
- Purging replaces the active R2 object with a higher-revision tombstone. A later put can replace that tombstone, but an older delayed write cannot recreate purged content.
- R2 tombstones are durably queued in SQLite and drained in bounded batches. A failed R2 operation leaves its tombstone queued so a later purge can retry it instead of losing the anti-resurrection fence.
- A stale R2 response inside its SWR window returns immediately while `ctx.waitUntil()` runs one claimed regeneration. A later Workers Cache request promotes the completed revision, so one extra stale response is possible.
- Hard-expired responses are never served. Reads wait for regeneration and therefore require a stored revalidator descriptor.
- Abandoned write reservations are retained for one hour before alarm-driven cleanup fences them from later publication. Response bodies are written only after Durable Object publication, so this cleanup does not perform R2 operations.
- RPC-transferred response bodies are buffered before R2 writes because transferred streams do not retain the fixed-length marker required by R2's single-part put API. Account for Worker memory limits when choosing maximum response sizes.
- Service-binding callbacks remain pinned to the application Worker version that supplied the revalidator capability.

### Version retention and cleanup

Backing data is scoped by the application Worker version ID. A new deployment therefore starts with a cold backing layout while retaining prior versions for rollback. Deploying a new version does not delete the old version's R2 objects or metadata Durable Objects, and the library does not currently run cross-version garbage collection.

This is deployment compatibility, not an in-place object-layout migration. Every invocation remains partitioned by its application Worker version ID. In self-contained mode, a newly deployed application version starts cold and leaves the previous version's data available for rollback. In service-binding mode, upgrading only the cache Worker keeps the existing application version IDs but treats entries in the previous R2 layout as cold misses; existing clients refill them through the unchanged API, and legacy cache-key formats remain valid ordinary keys. The old R2 objects are retained until that application version is cleaned up. Do not manually assign one application version ID to unrelated deployments.

Keep every version that can still receive traffic or be rolled back to. When a version is permanently retired:

1. If it is still addressable, call `purge({ purgeEverything: true })` through that version to tombstone its metadata and active R2 response objects. This also requests a broad edge-cache purge, so other versions may need to refill.
2. Delete any remaining objects under its R2 prefix: `runtime-cache/<version-id>/` contains every storage layout and shard count for that application version.
3. If you need to reclaim the retired metadata Durable Object's SQLite storage, use an application-owned administrative path to call `deleteAll()` on each known object. The current layout is named `<version-id>:r2-v1` without sharding, or `<version-id>:r2-v1:metadata-shard:<index>-of-<count>` for each shard. Older layouts may have additional objects. This cleanup is outside the package API.

Do not delete the shared Durable Object namespace while active versions use it. Avoid an age-only R2 lifecycle rule unless it is guaranteed to outlive every valid response and rollback window; explicit retired-version prefixes avoid deleting old but still-active cache entries.

Runnable single-Worker and service-binding integrations are available under `example/` in this package's source repository.
