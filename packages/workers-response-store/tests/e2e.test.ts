import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, test, vi } from "vitest";

import type {
  ResponseStorePurgeOptions,
  ResponseStoreRefreshOptions,
  SerializableValue,
} from "../src/index.js";
import { IsolateNegativeCache } from "../src/isolate-negative-cache.js";

const workerScript = fileURLToPath(new URL("../dist/worker/worker.js", import.meta.url));
const versionId = "poc-v2";
const metadataName = `${versionId}:r2-v1`;
const r2Root = `runtime-cache/${versionId}/r2-v1`;

type PutOptions = {
  age?: number;
  bodyDelayMs?: number;
  bodyFailure?: boolean;
  cacheControl?: string;
  cdnCacheControl?: string;
  cloudflareCacheControl?: string;
  coalesce?: boolean;
  contentType?: string;
  host?: string;
  largeHeaderBytes?: number;
  noRevalidator?: boolean;
  purgeExisting?: boolean;
  revalidator?: Record<string, SerializableValue>;
  status?: number;
  shards?: number;
  tags?: string[];
  teeBody?: boolean;
};

let mf: Miniflare;
let worker: { fetch(...args: any[]): Promise<any> };

beforeEach(async () => {
  mf = new Miniflare({
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat"],
    unsafeEphemeralDurableObjects: true,
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: "user-worker",
        compatibilityDate: "2026-04-08",
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        scriptPath: workerScript,
        durableObjects: {
          CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
        },
        r2Buckets: { CACHE_BODIES: "programmatic-cache-test" },
        bindings: {
          CF_VERSION_METADATA: {
            id: "poc-v2",
            tag: "test",
            timestamp: "2026-09-04T00:00:00Z",
          },
        },
      },
    ],
  });
  worker = { fetch: mf.dispatchFetch.bind(mf) };
});

afterEach(async () => {
  vi.useRealTimers();
  await mf.dispose();
});

async function put(path: string, body: BodyInit | null, options: PutOptions = {}) {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "text/plain; charset=utf-8",
    "X-Response-Cache-Control":
      options.cacheControl ?? "public, max-age=60, stale-while-revalidate=60",
  });
  if (options.tags) headers.set("X-Response-Cache-Tag", options.tags.join(","));
  if (options.host) headers.set("X-Cache-Host", options.host);
  if (options.age !== undefined) headers.set("X-Response-Age", String(options.age));
  if (options.status !== undefined) headers.set("X-Response-Status", String(options.status));
  if (options.cloudflareCacheControl) {
    headers.set("X-Response-Cloudflare-CDN-Cache-Control", options.cloudflareCacheControl);
  }
  if (options.cdnCacheControl) {
    headers.set("X-Response-CDN-Cache-Control", options.cdnCacheControl);
  }
  if (options.revalidator) {
    headers.set("X-Revalidator-Args", JSON.stringify(options.revalidator));
  }
  if (options.noRevalidator) headers.set("X-No-Revalidator", "1");
  if (options.purgeExisting) headers.set("X-Purge-Existing", "1");
  if (options.coalesce) headers.set("X-Coalesce", "1");
  if (options.bodyFailure) headers.set("X-Body-Failure", "1");
  if (options.bodyDelayMs) headers.set("X-Body-Delay-Ms", String(options.bodyDelayMs));
  if (options.teeBody) headers.set("X-Tee-Body", "1");
  if (options.largeHeaderBytes) {
    headers.set("X-Response-Large-Header-Bytes", String(options.largeHeaderBytes));
  }
  if (options.shards) headers.set("X-Response-Store-Shards", String(options.shards));
  const response = await worker.fetch(`https://user.test/admin/put${path}`, {
    method: "PUT",
    headers,
    body,
  });
  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`put fixture returned ${response.status}: ${text}`);
  }
  return { response, json: parsed };
}

async function read(
  path: string,
  options: { headers?: HeadersInit; host?: string; shards?: number } = {},
) {
  const headers = new Headers(options.headers);
  if (options.host) headers.set("X-Cache-Host", options.host);
  if (options.shards) headers.set("X-Response-Store-Shards", String(options.shards));
  return worker.fetch(`https://user.test/cache${path}`, { headers });
}

async function refreshSelectors(options: ResponseStoreRefreshOptions, shards?: number) {
  const response = await worker.fetch("https://user.test/admin/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(shards ? { "X-Response-Store-Shards": String(shards) } : {}),
    },
    body: JSON.stringify(options),
  });
  return { response, json: await response.json() };
}

async function purge(options: ResponseStorePurgeOptions, shards?: number) {
  const response = await worker.fetch("https://user.test/admin/purge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(shards ? { "X-Response-Store-Shards": String(shards) } : {}),
    },
    body: JSON.stringify(options),
  });
  return { response, json: await response.json() };
}

async function tagExpiration(tags: string[], shards?: number): Promise<number> {
  const response = await worker.fetch("https://user.test/admin/tag-expiration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(shards ? { "X-Response-Store-Shards": String(shards) } : {}),
    },
    body: JSON.stringify({ tags }),
  });
  const body = (await response.json()) as { expiration: number };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.expiration;
}

async function metadataStub() {
  const namespace = await mf.getDurableObjectNamespace("CACHE_METADATA", "user-worker");
  return namespace.getByName(metadataName) as any;
}

async function metadata(): Promise<any[]> {
  return (await metadataStub()).inspect();
}

async function metadataRowCount(table: string, name = metadataName): Promise<number> {
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name,
  });
  const [row] = await storage.exec(`SELECT COUNT(*) AS count FROM ${table}`);
  return row.count as number;
}

async function r2Objects() {
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  return bucket.list();
}

function metadataShardName(shards: number, index: number): string {
  return `${metadataName}:metadata-shard:${index}-of-${shards}`;
}

async function cacheKeyShard(cacheKey: string, shards: number): Promise<number> {
  const hash = await cacheKeyHash(cacheKey);
  return Number.parseInt(hash.slice(0, 8), 16) % shards;
}

async function cacheKeyHash(cacheKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function onePathPerShard(shards: number): Promise<string[]> {
  const paths: Array<string | undefined> = Array.from({ length: shards });
  let found = 0;
  for (let candidate = 0; found < shards; candidate++) {
    const path = `/sharded/${candidate}`;
    const shard = await cacheKeyShard(path, shards);
    if (paths[shard] === undefined) {
      paths[shard] = path;
      found++;
    }
  }
  return paths as string[];
}

test("isolate miss caching expires and evicts least-recently-used keys", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const cache = new IsolateNegativeCache<string>(2, 1_000);

  cache.add("oldest");
  cache.add("newer");
  assert.equal(cache.has("oldest"), true);
  cache.add("newest");
  assert.equal(cache.has("newer"), false);
  assert.equal(cache.has("oldest"), true);
  assert.equal(cache.has("newest"), true);

  vi.advanceTimersByTime(1_001);
  assert.equal(cache.has("oldest"), false);
  assert.equal(cache.has("newest"), false);
});

test("a put after a miss is visible to the next read", async () => {
  assert.equal((await read("/miss-then-put")).status, 404);
  await put("/miss-then-put", "stored-after-miss");

  const stored = await read("/miss-then-put");
  assert.equal(stored.status, 200);
  assert.equal(await stored.text(), "stored-after-miss");
});

test("put clears a miss cached while the write is in flight", async () => {
  const write = put("/miss-during-put", "stored-after-delayed-put", { bodyDelayMs: 200 });
  let pendingObjects = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    pendingObjects = await metadataRowCount("pending_objects");
    if (pendingObjects > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(pendingObjects, 1);
  assert.equal((await read("/miss-during-put")).status, 404);

  await write;
  const stored = await read("/miss-during-put");
  assert.equal(stored.status, 200);
  assert.equal(await stored.text(), "stored-after-delayed-put");
});

test("put and fetch use pathname plus query, excluding host", async () => {
  const result = await put("/identity?a=1", "first", { host: "one.example" });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const sameKey = await read("/identity?a=1", { host: "two.example" });
  assert.equal(sameKey.status, 200);
  assert.equal(await sameKey.text(), "first");
  assert.equal(sameKey.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");

  const differentQuery = await read("/identity?a=2", { host: "one.example" });
  assert.equal(differentQuery.status, 404);

  const entries = await metadata();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cacheKey, "/identity?a=1");
  assert.equal("body" in entries[0], false);
  const objects = await r2Objects();
  assert.equal(objects.objects.length, 1);
  assert.match(objects.objects[0].key, /\/active$/);
  assert.equal(entries[0].objectKey, objects.objects[0].key);
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const object = await bucket.head(objects.objects[0].key);
  assert.ok(object);
  assert.ok(object.customMetadata);
  assert.deepEqual(Object.keys(object.customMetadata).sort(), [
    "createdAt",
    "freshUntil",
    "initialAge",
    "latestRevision",
    "responseHeaders",
    "status",
    "statusText",
    "swrUntil",
  ]);
  assert.equal(object.customMetadata.status, "200");
  assert.equal(object.customMetadata.initialAge, "0");
  assert.match(object.customMetadata.createdAt, /^\d{13}$/);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("large response headers are stored in the R2 object body envelope", async () => {
  const result = await put("/large-response-headers", "body", { largeHeaderBytes: 9_000 });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const response = await read("/large-response-headers");
  assert.equal(response.headers.get("X-Large-Response-Header"), "x".repeat(9_000));
  assert.equal(await response.text(), "body");

  const object = await (
    await mf.getR2Bucket("CACHE_BODIES", "user-worker")
  ).head((await r2Objects()).objects[0].key);
  assert.match(object?.customMetadata?.responseMetadataBytes ?? "", /^\d+$/);
  assert.equal(object?.customMetadata?.responseHeaders, undefined);
});

test("default R2 keys fetch and miss without SQLite", async () => {
  const path = "/r2-native";
  const digest = await cacheKeyHash(path);
  const result = await put(path, "stored-through-r2", {
    cacheControl: "public, max-age=60, stale-while-revalidate=60",
  });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const objects = await r2Objects();
  assert.deepEqual(
    objects.objects.map(({ key }) => key),
    [`${r2Root}/${digest}/active`],
  );

  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  await storage.exec("DROP TABLE entries");

  const stored = await read(path);
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(await stored.text(), "stored-through-r2");

  const miss = await read("/r2-miss");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("X-Workers-Response-Store"), "MISS");
});

test("versioned response-store keys remain ordinary keys in the Worker and shard layout", async () => {
  const digest = "01".repeat(32);
  const path = `/r2-sharded?__workers_response_store=v1.${digest}`;
  await put(path, "sharded", { shards: 4 });

  assert.deepEqual(
    (await r2Objects()).objects.map(({ key }) => key),
    [`${r2Root}/shards-4/${await cacheKeyHash(path)}/active`],
  );
  assert.equal(
    await metadataRowCount("entries", metadataShardName(4, await cacheKeyShard(path, 4))),
    1,
  );
  assert.equal(await (await read(path, { shards: 4 })).text(), "sharded");
});

test("a versioned-looking query parameter cannot alias another cache key", async () => {
  const victim = "/digest-victim";
  const attacker = `/digest-attacker?__workers_response_store=v1.${await cacheKeyHash(victim)}`;
  await put(victim, "victim");
  await put(attacker, "attacker");

  assert.equal(await (await read(victim)).text(), "victim");
  assert.equal(await (await read(attacker)).text(), "attacker");
  assert.equal((await r2Objects()).objects.length, 2);
});

test("framework-specific and malformed markers remain ordinary R2 keys", async () => {
  const frameworkKey = `/framework-key?__some_framework_cache_key=${"12".repeat(32)}`;
  const malformedNewKey = "/malformed-key?__workers_response_store=not-versioned";
  await put(frameworkKey, "framework");
  await put(malformedNewKey, "malformed");

  const objects = await r2Objects();
  assert.deepEqual(
    objects.objects.map(({ key }) => key).sort(),
    [
      `${r2Root}/${await cacheKeyHash(frameworkKey)}/active`,
      `${r2Root}/${await cacheKeyHash(malformedNewKey)}/active`,
    ].sort(),
  );
  assert.equal(await (await read(frameworkKey)).text(), "framework");
  assert.equal(await (await read(malformedNewKey)).text(), "malformed");
});

test("legacy revision objects become cold misses and refill through the unchanged API", async () => {
  const path = `/legacy-layout?__vinext_response_store=${"34".repeat(32)}`;
  const digest = await cacheKeyHash(path);
  const namespace = await mf.getDurableObjectNamespace("CACHE_METADATA", "user-worker");
  const stub = namespace.getByName(versionId) as any;
  const reservation = await stub.reserveWrite(
    digest,
    path,
    `runtime-cache/${versionId}/${digest}`,
    Date.now(),
  );
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  await bucket.put(reservation.objectKey, "legacy-body", {
    customMetadata: { status: "200", createdAt: String(Date.now()), initialAge: "0" },
  });
  const publication = await stub.publish(digest, reservation.revision, {
    objectKey: reservation.objectKey,
    statusText: "",
    responseHeaders: [["cache-control", "public, max-age=60"]],
    freshUntil: Date.now() + 60_000,
    swrUntil: Date.now() + 60_000,
    revalidator: null,
    cacheTags: [],
    fenceTags: [],
  });
  assert.equal(publication.published, true);

  assert.equal((await read(path)).status, 404);
  assert.deepEqual((await put(path, "current-layout")).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  assert.equal(await (await read(path)).text(), "current-layout");
  assert.equal((await metadata())[0].objectKey, `${r2Root}/${digest}/active`);
  assert.notEqual(await bucket.head(reservation.objectKey), null);
  assert.notEqual(await bucket.head(`${r2Root}/${digest}/active`), null);
});

test("purge fences a default R2 key with a tombstone that a later put replaces", async () => {
  const path = "/r2-purge";
  const digest = await cacheKeyHash(path);
  const objectKey = `${r2Root}/${digest}/active`;
  await put(path, "before-purge", { tags: ["r2-tag"] });

  const purged = await purge({ tags: ["r2-tag"] });
  assert.deepEqual(purged.json, { backingStoreUpdated: true, edgePurgeAccepted: false });

  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const tombstone = await bucket.head(objectKey);
  assert.deepEqual(tombstone?.customMetadata, {
    latestRevision: "2",
    tombstoned: "1",
  });
  assert.equal(tombstone?.size, 0);
  assert.equal((await read(path)).status, 404);

  await put(path, "after-purge");
  const replacement = await bucket.head(objectKey);
  assert.equal(replacement?.customMetadata?.tombstoned, undefined);
  assert.equal(replacement?.customMetadata?.latestRevision, "3");
  assert.equal(await (await read(path)).text(), "after-purge");
});

test("a reserved write cannot recreate a default R2 object after purge", async () => {
  const path = "/r2-purge-race";
  const digest = await cacheKeyHash(path);
  const objectKey = `${r2Root}/${digest}/active`;
  await put(path, "active");

  const delayed = put(path, "too-late", { bodyDelayMs: 300 });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("pending_objects")) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await metadataRowCount("pending_objects"), 1);

  await purge({ pathPrefixes: ["/r2-purge-race"] });
  assert.deepEqual((await delayed).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });

  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const tombstone = await bucket.head(objectKey);
  assert.equal(tombstone?.customMetadata?.tombstoned, "1");
  assert.equal(tombstone?.customMetadata?.latestRevision, "3");
  assert.equal((await read(path)).status, 404);
});

test("refresh rewrites the metadata and body on a default R2 object", async () => {
  const path = "/r2-refresh";
  const digest = await cacheKeyHash(path);
  const objectKey = `${r2Root}/${digest}/active`;
  await put(path, "before-refresh", {
    revalidator: { body: "after-refresh", cacheControl: "public, max-age=60" },
  });

  const refreshed = await refreshSelectors({ pathPrefixes: ["/r2-refresh"] });
  assert.equal(refreshed.json.backingStoreUpdated, true);

  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const object = await bucket.head(objectKey);
  assert.equal(object?.customMetadata?.latestRevision, "2");
  assert.equal(await (await read(path)).text(), "after-refresh");
});

test("opt-in shards distribute keys while preserving refresh, tag invalidation, and SWR", async () => {
  const shards = 4;
  const paths = await onePathPerShard(shards);

  for (const [index, path] of paths.entries()) {
    await put(path, `seed-${index}`, {
      revalidator: {
        body: `refreshed-${index}`,
        cacheControl: "public, max-age=60",
        cacheTags: ["sharded-tag"],
      },
      shards,
      tags: ["sharded-tag"],
    });
  }

  const namespace = await mf.getDurableObjectNamespace("CACHE_METADATA", "user-worker");
  for (let index = 0; index < shards; index++) {
    const entries = await (namespace.getByName(metadataShardName(shards, index)) as any).inspect();
    assert.equal(entries.length, 1);
  }

  assert.deepEqual((await refreshSelectors({ tags: ["SHARDED-TAG"] }, shards)).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  for (const [index, path] of paths.entries()) {
    assert.equal(await (await read(path, { shards })).text(), `refreshed-${index}`);
  }

  assert.deepEqual((await purge({ tags: ["sharded-tag"] }, shards)).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  const expirations = await Promise.all(
    Array.from({ length: shards }, (_, index) =>
      (namespace.getByName(metadataShardName(shards, index)) as any).getTagExpiration([
        "sharded-tag",
      ]),
    ),
  );
  assert.ok(expirations[0] > 0);
  assert.ok(expirations.every((expiration) => expiration === expirations[0]));
  assert.equal(await tagExpiration(["sharded-tag"], shards), expirations[0]);
  for (const path of paths) assert.equal((await read(path, { shards })).status, 404);

  const swrPath = paths[0];
  await put(swrPath, "stale", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: { body: "fresh", cacheControl: "public, max-age=60", delayMs: 100 },
    shards,
  });
  const stale = await Promise.all(Array.from({ length: 4 }, () => read(swrPath, { shards })));
  assert.deepEqual(await Promise.all(stale.map((response) => response.text())), [
    "stale",
    "stale",
    "stale",
    "stale",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await (await read(swrPath, { shards })).text(), "fresh");
});

test("sharded refresh completes healthy shards before reporting reservation failures", async () => {
  const shards = 4;
  const paths = await onePathPerShard(shards);

  for (const [index, path] of paths.entries()) {
    await put(path, `seed-${index}`, {
      revalidator: { body: `refreshed-${index}`, cacheControl: "public, max-age=60" },
      shards,
      tags: ["partial-refresh"],
    });
  }

  const failedShard = 0;
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataShardName(shards, failedShard),
  });
  await storage.exec("DROP TABLE entries");

  const result = await refreshSelectors({ tags: ["partial-refresh"] }, shards);
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.json, { error: "One or more cache entries failed to refresh" });

  for (let index = 1; index < shards; index++) {
    assert.equal(await (await read(paths[index], { shards })).text(), `refreshed-${index}`);
  }
});

test("a sharded tag purge fences an in-flight publication on its key shard", async () => {
  const shards = 4;
  const path = "/sharded/pending-tag";
  const shardName = metadataShardName(shards, await cacheKeyShard(path, shards));
  const write = put(path, "too-late", {
    bodyDelayMs: 300,
    shards,
    tags: ["pending-sharded-tag"],
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("pending_objects", shardName)) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await metadataRowCount("pending_objects", shardName), 1);

  await purge({ tags: ["pending-sharded-tag"] }, shards);
  assert.deepEqual((await write).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.equal((await read(path, { shards })).status, 404);
});

test("null-body response statuses refill without an R2 body stream", async () => {
  const result = await put("/no-content", "ignored", { status: 204 });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const response = await read("/no-content");
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal((await r2Objects()).objects.length, 1);
});

test("a cold refill preserves downstream headers, representation age, and remaining freshness", async () => {
  await put("/freshness", "aged", {
    cacheControl: "public, max-age=100, stale-while-revalidate=100",
    cloudflareCacheControl: "max-age=3, stale-while-revalidate=4",
    age: 1,
  });

  const first = await read("/freshness");
  assert.equal(
    first.headers.get("Cache-Control"),
    "public, max-age=100, stale-while-revalidate=100",
  );
  assert.equal(
    first.headers.get("Cloudflare-CDN-Cache-Control"),
    "max-age=2, stale-while-revalidate=4",
  );
  assert.equal(first.headers.get("Age"), "1");
  const ageBasis = first.headers.get("X-Workers-Response-Store-Age-Basis");
  assert.ok(ageBasis);
  assert.match(ageBasis, /^\d{13}:1$/);
  await first.arrayBuffer();

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const later = await read("/freshness");
  assert.match(
    later.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=[01], stale-while-revalidate=4$/,
  );
  assert.ok(Number(later.headers.get("Age")) >= 2);
  assert.equal(later.headers.get("X-Workers-Response-Store-Age-Basis"), ageBasis);
});

test("cache policy disables SWR when Workers Cache forbids stale serving", async () => {
  for (const [path, cacheControl] of [
    ["/policy/s-maxage", "public, s-maxage=60, stale-while-revalidate=30"],
    ["/policy/must-revalidate", "public, max-age=60, must-revalidate, stale-while-revalidate=30"],
    ["/policy/proxy-revalidate", "public, max-age=60, proxy-revalidate, stale-while-revalidate=30"],
  ]) {
    await put(path, "policy", { cacheControl });
    const response = await read(path);
    assert.equal(
      response.headers.get("Cloudflare-CDN-Cache-Control"),
      "max-age=60, stale-while-revalidate=0",
    );
  }

  await put("/policy/no-cache", "policy", {
    cacheControl: "public, no-cache, max-age=60, stale-while-revalidate=30",
    noRevalidator: true,
  });
  const immediatelyStale = await read("/policy/no-cache");
  assert.equal(immediatelyStale.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(
    immediatelyStale.headers.get("Cloudflare-CDN-Cache-Control"),
    "max-age=0, stale-while-revalidate=30",
  );

  await put("/policy/invalid-max-age", "policy", {
    cacheControl: "public, max-age=2.5, stale-while-revalidate=30",
    noRevalidator: true,
  });
  const invalidMaxAge = await read("/policy/invalid-max-age");
  assert.equal(invalidMaxAge.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.match(
    invalidMaxAge.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=0, stale-while-revalidate=(29|30)$/,
  );

  await put("/policy/invalid-swr", "policy", {
    cacheControl: "public, max-age=60, stale-while-revalidate=30seconds",
  });
  const invalidSwr = await read("/policy/invalid-swr");
  assert.match(
    invalidSwr.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=(59|60), stale-while-revalidate=0$/,
  );
});

test("stale R2 content returns immediately and deduplicates background regeneration", async () => {
  await put("/stale", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: {
      body: "swr-regenerated",
      cacheControl: "public, max-age=60, stale-while-revalidate=30",
      delayMs: 500,
    },
  });

  const startedAt = Date.now();
  const responses = await Promise.all(Array.from({ length: 8 }, () => read("/stale")));
  assert.ok(Date.now() - startedAt < 400, "stale reads should not await the 500ms regeneration");
  assert.deepEqual(
    await Promise.all(responses.map((response) => response.text())),
    Array.from({ length: 8 }, () => "stale-body"),
  );
  assert.equal(responses[0].headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.match(
    responses[0].headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=0, stale-while-revalidate=(29|30)$/,
  );

  await new Promise((resolve) => setTimeout(resolve, 650));
  const fresh = await read("/stale");
  assert.equal(await fresh.text(), "swr-regenerated");
  assert.equal(fresh.headers.get("X-Revalidation-Reason"), "swr");
  assert.equal(fresh.headers.get("X-Workers-Response-Store-Revision"), "2");
  const stats = (await (await worker.fetch("https://user.test/admin/stats")).json()) as {
    regenerationCount: number;
  };
  assert.equal(stats.regenerationCount, 1);
  assert.equal(await metadataRowCount("revalidation_claims"), 0);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("a failed background regeneration releases its claim for a later retry", async () => {
  await put("/stale-retry", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: {
      body: "retry-succeeded",
      cacheControl: "public, max-age=60",
      failOnce: true,
    },
  });

  assert.equal(await (await read("/stale-retry")).text(), "stale-body");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await (await read("/stale-retry")).text(), "stale-body");

  await new Promise((resolve) => setTimeout(resolve, 100));
  const fresh = await read("/stale-retry");
  assert.equal(await fresh.text(), "retry-succeeded");
  const stats = (await (await worker.fetch("https://user.test/admin/stats")).json()) as {
    regenerationCount: number;
  };
  assert.equal(stats.regenerationCount, 2);
});

test("hard-expired content is never returned and regeneration is committed before serving", async () => {
  await put("/expired", "must-not-return", {
    cacheControl: "public, max-age=0",
    revalidator: {
      body: "regenerated-body",
      cacheControl: "public, max-age=60, stale-while-revalidate=30",
    },
  });

  const response = await read("/expired", {
    headers: { "X-Visitor-Secret": "must-not-reach-regeneration" },
  });
  assert.equal(await response.text(), "regenerated-body");
  assert.equal(response.headers.get("X-Revalidation-Reason"), "expired");
  assert.equal(response.headers.get("X-Revalidation-Request"), "/expired");
  assert.equal(response.headers.get("X-Revalidation-Observed-Visitor"), "absent");
  assert.equal(response.headers.get("X-Revalidation-Version"), "poc-v2");
  assert.equal(response.headers.get("X-Workers-Response-Store-Revision"), "2");
  const objects = await r2Objects();
  assert.equal(objects.objects.length, 1, "the superseded R2 revision is deleted");
});

test("missing R2 content returns a cache miss without querying metadata", async () => {
  const path = "/missing-body";
  await put(path, "lost");
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const before = await bucket.list();
  await bucket.delete(before.objects[0].key);

  const response = await read(path);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Workers-Response-Store"), "MISS");
});

test("manual refresh replaces R2 before reporting the local edge-purge limitation", async () => {
  await put("/refresh", "seed", {
    tags: ["manual-refresh"],
    revalidator: { bodyPrefix: "manual", cacheControl: "public, max-age=60" },
  });
  const result = await refreshSelectors({ tags: ["manual-refresh"] });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: false });

  const response = await read("/refresh");
  assert.match(await response.text(), /^manual:1:/);
  assert.equal(response.headers.get("X-Revalidation-Reason"), "manual");
  assert.equal((await r2Objects()).objects.length, 1);
});

test("refresh selects entries by tag and path prefix", async () => {
  await put("/refresh-select/tagged", "tagged-seed", {
    tags: ["refresh-group"],
    revalidator: {
      body: "tag-refreshed",
      cacheControl: "public, max-age=60",
      cacheTags: ["refresh-group"],
    },
  });
  await put("/refresh-select/prefix/a", "prefix-seed", {
    revalidator: { body: "prefix-refreshed", cacheControl: "public, max-age=60" },
  });
  await put("/refresh-select/untouched", "untouched-seed", {
    revalidator: { body: "should-not-run", cacheControl: "public, max-age=60" },
  });

  assert.deepEqual((await refreshSelectors({ tags: ["REFRESH-GROUP"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/refresh-select/tagged")).text(), "tag-refreshed");
  assert.equal(await (await read("/refresh-select/prefix/a")).text(), "prefix-seed");

  assert.deepEqual((await refreshSelectors({ pathPrefixes: ["/refresh-select/prefix"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/refresh-select/prefix/a")).text(), "prefix-refreshed");
  assert.equal(await (await read("/refresh-select/untouched")).text(), "untouched-seed");
  assert.equal((await r2Objects()).objects.length, 3);
});

test("refresh accepts more tag selectors than one SQLite parameter batch", async () => {
  const tags = Array.from({ length: 101 }, (_, index) => `selector-${index}`);
  await put("/refresh-many-tags", "seed", {
    tags: [tags.at(-1)!],
    revalidator: { body: "refreshed", cacheControl: "public, max-age=60" },
  });

  assert.deepEqual((await refreshSelectors({ tags })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/refresh-many-tags")).text(), "refreshed");
});

test("refresh reserves more than one SQLite batch in one metadata call", async () => {
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      put(`/refresh-batch/${index}`, "seed", {
        tags: ["refresh-batch"],
        revalidator: { body: "refreshed", cacheControl: "public, max-age=60" },
      }),
    ),
  );

  assert.deepEqual((await refreshSelectors({ tags: ["refresh-batch"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal((await metadata()).filter((entry) => entry.activeRevision === 2).length, 101);
  assert.equal(await metadataRowCount("pending_objects"), 0);
  assert.equal((await r2Objects()).objects.length, 101);
});

test("manual refresh bounds revalidator concurrency and completes every candidate", async () => {
  const candidateCount = 13;
  await Promise.all(
    Array.from({ length: candidateCount }, (_, index) =>
      put(`/refresh-concurrency/${index}`, `seed-${index}`, {
        tags: ["refresh-concurrency"],
        revalidator: {
          body: `refreshed-${index}`,
          cacheControl: "public, max-age=60",
          delayMs: 50,
          fail: index === candidateCount - 1,
        },
      }),
    ),
  );

  const result = await refreshSelectors({ tags: ["refresh-concurrency"] });
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.json, { error: "One or more cache entries failed to refresh" });

  const stats = (await (await worker.fetch("https://user.test/admin/stats")).json()) as {
    activeRegenerationCount: number;
    maxConcurrentRegenerations: number;
    regenerationCount: number;
  };
  assert.deepEqual(stats, {
    activeRegenerationCount: 0,
    maxConcurrentRegenerations: 6,
    regenerationCount: candidateCount,
  });

  for (let index = 0; index < candidateCount; index++) {
    assert.equal(
      await (await read(`/refresh-concurrency/${index}`)).text(),
      index === candidateCount - 1 ? `seed-${index}` : `refreshed-${index}`,
    );
  }
});

test("refresh and purge select entries from their stored tags", async () => {
  await put("/tag-index", "seed", {
    tags: ["Original", "Shared"],
    revalidator: {
      body: "refreshed",
      cacheControl: "public, max-age=60",
      cacheTags: ["Replacement"],
    },
  });

  assert.deepEqual((await metadata())[0].cacheTags, ["Original", "Shared"]);
  assert.equal(await metadataRowCount("entry_tags"), 2);
  assert.deepEqual((await refreshSelectors({ tags: ["ORIGINAL"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.deepEqual((await metadata())[0].cacheTags, ["Replacement"]);
  assert.equal(await metadataRowCount("entry_tags"), 1);
  assert.deepEqual((await refreshSelectors({ tags: ["original"] })).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });

  await purge({ tags: ["REPLACEMENT"] });
  assert.equal((await read("/tag-index")).status, 404);
  assert.equal(await metadataRowCount("entry_tags"), 0);
  assert.ok((await (await metadataStub()).getTagExpiration(["replacement"])) > 0);
});

test("tag expiration is recorded without creating an R2 marker object", async () => {
  const before = Date.now();
  await purge({ tags: ["missing-tag"] });

  const stub = await metadataStub();
  assert.ok((await stub.getTagExpiration(["missing-tag"])) >= before);
  assert.equal(await stub.getTagExpiration(["other-tag"]), 0);

  const batchedTags = Array.from({ length: 101 }, (_, index) => `tag-${index}`);
  await purge({ tags: batchedTags });
  assert.ok((await stub.getTagExpiration(batchedTags)) >= before);
  assert.equal((await r2Objects()).objects.length, 0);
});

test("tag expiration lookup reads authoritative invalidation state", async () => {
  const before = Date.now();
  assert.equal(await tagExpiration(["unchanged"]), 0);

  await purge({ tags: ["changed"] });
  assert.ok((await tagExpiration(["changed"])) >= before);
  assert.equal(await tagExpiration(["unchanged"]), 0);
});

test("the internal purge tag is first and large tag sets remain selectable", async () => {
  await put("/cache-tag-order", "tagged", { tags: ["user-tag"] });
  const taggedResponse = await read("/cache-tag-order");
  const cacheTag = taggedResponse.headers.get("Cache-Tag");
  assert.ok(cacheTag);
  assert.ok(cacheTag.startsWith("runtime-cache-"));
  await taggedResponse.arrayBuffer();

  const tags = Array.from(
    { length: 1_000 },
    (_, index) => `cache-tag-${String(index).padStart(4, "0")}-abcdefgh`,
  );
  await put("/many-cache-tags", "tagged", { tags });
  assert.equal(await metadataRowCount("entry_tags"), 1_001);

  await purge({ tags: [tags.at(-1)!] });
  assert.equal((await read("/many-cache-tags")).status, 404);
  assert.equal(await (await read("/cache-tag-order")).text(), "tagged");
  assert.equal(await metadataRowCount("entry_tags"), 1);
});

test("purge supports tags, path prefixes, and purgeEverything", async () => {
  await put("/posts/a", "a", { tags: ["posts", "a"] });
  await put("/posts/b", "b", { tags: ["posts", "b"] });
  await put("/other", "other", { tags: ["other"] });

  assert.deepEqual((await purge({ tags: ["a"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal((await read("/posts/a")).status, 404);
  assert.equal(await (await read("/posts/b")).text(), "b");

  await purge({ pathPrefixes: ["/posts"] });
  assert.equal((await read("/posts/b")).status, 404);
  assert.equal(await (await read("/other")).text(), "other");

  await purge({ purgeEverything: true });
  assert.equal((await read("/other")).status, 404);
  assert.equal((await r2Objects()).objects.length, 3);
});

test("a failed R2 purge remains queued and retryable after SQLite is tombstoned", async () => {
  await put("/retry-purge", "still-readable-until-r2-is-tombstoned", {
    tags: ["retry-purge"],
  });
  const stub = await metadataStub();
  const reserved = await stub.purgeMatching({ tags: ["retry-purge"] });
  assert.equal(reserved.pendingTombstones, 1);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);
  assert.equal(await (await read("/retry-purge")).text(), "still-readable-until-r2-is-tombstoned");

  const retry = await stub.purgeMatching({ tags: ["retry-purge"] });
  assert.equal(retry.pendingTombstones, 1);
  assert.deepEqual(await stub.listPendingEdgePurges(400), []);
  const drained = await stub.drainPendingTombstones(400);
  assert.deepEqual(drained.failures, []);
  assert.equal(drained.purged.length, 1);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);
  assert.equal((await stub.listPendingEdgePurges(400)).length, 1);
  await stub.markTombstonesEdgePurged(drained.pending);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 0);
  assert.equal((await read("/retry-purge")).status, 404);
});

test("autonomous cleanup retains edge work when cache purge is unavailable", async () => {
  await put("/alarm-purge", "old", { tags: ["alarm-purge"] });
  const stub = await metadataStub();
  const reserved = await stub.purgeMatching({ tags: ["alarm-purge"] });
  assert.equal(reserved.pendingTombstones, 1);
  assert.equal(await (await read("/alarm-purge")).text(), "old");

  await assert.rejects(stub.retryPendingTombstones());

  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);
  assert.equal((await read("/alarm-purge")).status, 404);
  await stub.markTombstonesEdgePurged(await stub.listPendingEdgePurges(1));
});

test("purge retains edge work when cache purge is unavailable", async () => {
  await put("/unavailable-tag-purge", "old", { tags: ["unavailable"] });
  await put("/unavailable-global-purge", "old");

  assert.deepEqual((await purge({ tags: ["unavailable"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);

  assert.deepEqual((await purge({ purgeEverything: true })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 2);

  const stub = await metadataStub();
  await stub.markTombstonesEdgePurged(await stub.listPendingEdgePurges(2));
});

test("a broad purge only acknowledges tombstones in its snapshot", async () => {
  await put("/broad-purge-snapshot", "old", { tags: ["snapshot"] });
  await put("/broad-purge-later", "old", { tags: ["later"] });
  const stub = await metadataStub();

  const snapshot = await stub.purgeMatching({ tags: ["snapshot"] });
  await stub.drainPendingTombstones(400);
  await stub.purgeMatching({ tags: ["later"] });
  await stub.drainPendingTombstones(400);

  await stub.markTombstonesEdgePurgedThrough(snapshot.tombstoneSequence);
  assert.deepEqual(
    (await stub.listPendingEdgePurges(400)).map(({ cacheKey }: { cacheKey: string }) => cacheKey),
    ["/broad-purge-later"],
  );
  await stub.markTombstonesEdgePurged(await stub.listPendingEdgePurges(400));
});

test("a failed R2 publication can be fenced with a newer tombstone", async () => {
  await put("/failed-publication", "possibly-committed", { tags: ["failed-publication"] });
  await put("/unrelated-pending-tombstone", "unrelated", { tags: ["unrelated"] });
  const entry = (await metadata()).find(({ cacheKey }) => cacheKey === "/failed-publication");
  assert.ok(entry);
  const stub = await metadataStub();
  await stub.purgeMatching({ tags: ["unrelated"] });
  assert.equal(await metadataRowCount("entry_tags"), 1);

  const reconciled = await stub.invalidatePublishedRevision(entry.keyHash, entry.activeRevision);

  assert.deepEqual(reconciled.failures, []);
  assert.equal(reconciled.purged.length, 1);
  assert.equal(reconciled.pending[0].keyHash, entry.keyHash);
  assert.equal(await metadataRowCount("entry_tags"), 0);
  await stub.markTombstonesEdgePurged(reconciled.pending);
  assert.deepEqual(await metadata(), []);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);

  const unrelated = await stub.drainPendingTombstones(1);
  assert.equal(unrelated.pending[0].cacheKey, "/unrelated-pending-tombstone");
  await stub.markTombstonesEdgePurged(unrelated.pending);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 0);
  assert.equal((await read("/failed-publication")).status, 404);

  await put("/failed-publication", "replacement");
  assert.equal(await (await read("/failed-publication")).text(), "replacement");
});

test("purge batches more entries than the SQL and R2 drain limits", async () => {
  await Promise.all(
    Array.from({ length: 401 }, (_, index) => put(`/large-purge/${index}`, `${index}`)),
  );

  assert.deepEqual((await purge({ pathPrefixes: ["/large-purge/"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal((await metadata()).length, 0);
  assert.equal((await r2Objects()).objects.length, 401);
});

test("a newer put wins and the superseded candidate is cleaned up", async () => {
  const slow = put("/race", "slow", { bodyDelayMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fast = await put("/race", "fast");
  const slowResult = await slow;

  assert.deepEqual(fast.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.deepEqual(slowResult.json, { backingStoreUpdated: false, edgePurgeAccepted: false });
  assert.equal(await (await read("/race")).text(), "fast");
  assert.equal((await r2Objects()).objects.length, 1);
});

test("overlapping framework writes can be coalesced", async () => {
  const first = put("/coalesced", "first", { bodyDelayMs: 300, coalesce: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await put("/coalesced", "second", { coalesce: true });
  const firstResult = await first;

  assert.deepEqual(firstResult.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.deepEqual(second.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.equal(await (await read("/coalesced")).text(), "first");
  assert.equal((await metadata())[0].activeRevision, 1);
  assert.equal((await r2Objects()).objects.length, 1);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("a coalesced tee body does not block on its unread sibling", async () => {
  const first = put("/coalesced-tee", "first", { bodyDelayMs: 300, coalesce: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = put("/coalesced-tee", "second", { coalesce: true, teeBody: true });

  assert.deepEqual((await second).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  await first;
});

test("writes with different purge requirements are not coalesced", async () => {
  const first = put("/coalesced-purge", "first", { bodyDelayMs: 300, coalesce: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await put("/coalesced-purge", "second", {
    coalesce: true,
    purgeExisting: true,
  });
  const firstResult = await first;

  assert.deepEqual(firstResult.json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.deepEqual(second.json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/coalesced-purge")).text(), "second");
});

test("a failed coalesced write does not suppress an immediate retry", async () => {
  await assert.rejects(
    put("/coalesced-retry", "fails", {
      bodyFailure: true,
      coalesce: true,
    }),
    /put fixture returned 500/,
  );

  const retry = await put("/coalesced-retry", "succeeds", { coalesce: true });
  assert.deepEqual(retry.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.equal(await (await read("/coalesced-retry")).text(), "succeeds");
});

test("a failed coalesced write preserves an overlapping successful write", async () => {
  const failing = put("/coalesced-fallback", "fails", {
    bodyDelayMs: 300,
    bodyFailure: true,
    coalesce: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fallback = put("/coalesced-fallback", "succeeds", { coalesce: true });

  await assert.rejects(failing, /put fixture returned 500/);
  assert.deepEqual((await fallback).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  assert.equal(await (await read("/coalesced-fallback")).text(), "succeeds");
});

test("a failed newer write does not discard an overlapping successful write", async () => {
  const successful = put("/write-fallback", "succeeds", { bodyDelayMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.rejects(
    put("/write-fallback", "fails", { bodyFailure: true }),
    /put fixture returned 500/,
  );
  assert.deepEqual((await successful).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  assert.equal(await (await read("/write-fallback")).text(), "succeeds");
});

test("purge prevents coalesced writes from resurrecting an entry", async () => {
  await put("/purge-coalesced", "seed");
  const first = put("/purge-coalesced", "first", { bodyDelayMs: 300, coalesce: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = put("/purge-coalesced", "second", { coalesce: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await purge({ purgeEverything: true });
  assert.deepEqual((await first).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.deepEqual((await second).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.equal((await read("/purge-coalesced")).status, 404);
  assert.equal((await r2Objects()).objects.length, 1);
});

test("purge prevents an initial slow write from creating an entry", async () => {
  const write = put("/purge-cold-write", "too-late", { bodyDelayMs: 300 });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("pending_objects")) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await metadataRowCount("pending_objects"), 1);

  await purge({ purgeEverything: true });
  assert.deepEqual((await write).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.equal((await read("/purge-cold-write")).status, 404);
  assert.equal((await r2Objects()).objects.length, 0);
});

test("repeated purge prevents a post-tombstone write from resurrecting an entry", async () => {
  await put("/purge-twice", "seed");
  await purge({ purgeEverything: true });
  const write = put("/purge-twice", "too-late", { bodyDelayMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await purge({ purgeEverything: true });
  assert.deepEqual((await write).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.equal((await read("/purge-twice")).status, 404);
});

test("tag purge prevents a pending tagged write from publishing", async () => {
  const write = put("/purge-pending-tag", "too-late", {
    bodyDelayMs: 300,
    tags: ["pending-tag"],
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("pending_objects")) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await metadataRowCount("pending_objects"), 1);

  await purge({ tags: ["pending-tag"] });
  assert.deepEqual((await write).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.equal((await read("/purge-pending-tag")).status, 404);
});

test("an expired revalidation claim cannot publish after its replacement", async () => {
  await put("/claim-replacement", "seed");
  const [entry] = await metadata();
  const stub = await metadataStub();
  const first = await stub.claimRevalidation(
    entry.keyHash,
    entry.activeRevision,
    entry.cacheKey,
    "runtime-cache/poc-v2/claim-replacement",
    100,
    1,
  );
  const second = await stub.claimRevalidation(
    entry.keyHash,
    entry.activeRevision,
    entry.cacheKey,
    "runtime-cache/poc-v2/claim-replacement",
    102,
    100,
  );
  assert.ok(first);
  assert.ok(second);

  const result = await stub.publish(
    entry.keyHash,
    first.revision,
    {
      objectKey: first.objectKey,
      statusText: "",
      responseHeaders: [],
      freshUntil: 1_000,
      swrUntil: 1_000,
      revalidator: null,
      cacheTags: [],
      fenceTags: [],
    },
    first.claimId,
  );
  assert.equal(result.published, false);
});

test("a revalidation claim cannot replace a newer active revision", async () => {
  await put("/claim-active-revision", "seed");
  const [entry] = await metadata();
  const stub = await metadataStub();
  const write = await stub.reserveWrite(
    entry.keyHash,
    entry.cacheKey,
    "runtime-cache/poc-v2/claim-active-revision",
    Date.now(),
  );
  const claim = await stub.claimRevalidation(
    entry.keyHash,
    entry.activeRevision,
    entry.cacheKey,
    "runtime-cache/poc-v2/claim-active-revision",
    100,
    100,
  );
  assert.ok(claim);

  const candidate = {
    statusText: "",
    responseHeaders: [],
    freshUntil: 1_000,
    swrUntil: 1_000,
    revalidator: null,
    cacheTags: [],
    fenceTags: [],
  };
  assert.equal(
    (
      await stub.publish(entry.keyHash, write.revision, {
        ...candidate,
        objectKey: write.objectKey,
      })
    ).published,
    true,
  );
  assert.equal(
    (
      await stub.publish(
        entry.keyHash,
        claim.revision,
        { ...candidate, objectKey: claim.objectKey },
        claim.claimId,
      )
    ).published,
    false,
  );
});

test("a write reserved after a tag purge is not rejected by its timestamp", async () => {
  const createdAt = Date.now();
  await purge({ tags: ["already-purged"] });

  const stub = await metadataStub();
  const reservation = await stub.reserveWrite(
    "post-purge-write",
    "/post-purge-write",
    "runtime-cache/poc-v2/post-purge-write",
    createdAt,
  );
  const result = await stub.publish("post-purge-write", reservation.revision, {
    objectKey: reservation.objectKey,
    statusText: "",
    responseHeaders: [],
    freshUntil: createdAt + 60_000,
    swrUntil: createdAt + 60_000,
    revalidator: null,
    cacheTags: ["already-purged"],
    fenceTags: ["already-purged"],
  });

  assert.equal(result.published, true);
});

test("a failed write replacement preserves an intervening purge fence", async () => {
  const stub = await metadataStub();
  const prefix = "runtime-cache/poc-v2/retry-fence";
  const first = await stub.reserveWrite("retry-fence", "/retry-fence", prefix, Date.now());
  const replacement = await stub.replaceFailedWrite(
    "retry-fence",
    "/retry-fence",
    prefix,
    first.objectKey,
    [],
    Date.now(),
  );
  assert.ok(replacement);

  await stub.purgeMatching({ purgeEverything: true });

  assert.equal(
    await stub.replaceFailedWrite(
      "retry-fence",
      "/retry-fence",
      prefix,
      replacement.objectKey,
      [],
      Date.now(),
    ),
    null,
  );
});

test("an unrelated purge does not discard a failed write replacement", async () => {
  const stub = await metadataStub();
  const prefix = "runtime-cache/poc-v2/retry-unrelated-purge";
  const first = await stub.reserveWrite(
    "retry-unrelated-purge",
    "/retry-unrelated-purge",
    prefix,
    Date.now(),
  );

  await stub.purgeMatching({ pathPrefixes: ["/other"] });

  assert.ok(
    await stub.replaceFailedWrite(
      "retry-unrelated-purge",
      "/retry-unrelated-purge",
      prefix,
      first.objectKey,
      [],
      Date.now(),
    ),
  );
});

test("the previous metadata schema is upgraded in place", async () => {
  const persistencePath = await mkdtemp(path.join(tmpdir(), "response-store-migration-"));
  let legacy;
  let upgraded;

  try {
    legacy = new Miniflare({
      compatibilityDate: "2026-04-08",
      resourcePersistencePath: persistencePath,
      unsafeEphemeralDurableObjects: true,
      workers: [
        {
          name: "migration-worker",
          modules: true,
          script: `
            import { DurableObject } from "cloudflare:workers";
            export class CacheMetadata extends DurableObject {
              constructor(ctx, env) {
                super(ctx, env);
                ctx.blockConcurrencyWhile(async () => ctx.storage.sql.exec(\`
                  CREATE TABLE tag_invalidations (
                    tag TEXT PRIMARY KEY,
                    invalidated_at INTEGER NOT NULL
                  ) WITHOUT ROWID;
                  CREATE TABLE entries (
                    key_hash TEXT PRIMARY KEY,
                    cache_key TEXT NOT NULL,
                    active_revision INTEGER,
                    latest_revision INTEGER NOT NULL,
                    object_key TEXT,
                    status_text TEXT,
                    response_headers TEXT,
                    fresh_until INTEGER,
                    swr_until INTEGER,
                    revalidator_id TEXT,
                    revalidator_args TEXT,
                    cache_tags TEXT,
                    tombstoned INTEGER NOT NULL DEFAULT 0
                  );
                  CREATE TABLE metadata_schema_migrations (version INTEGER PRIMARY KEY);
                  INSERT INTO metadata_schema_migrations (version) VALUES (1);
                  CREATE TABLE metadata_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    tag_invalidation_sequence INTEGER NOT NULL
                  );
                  INSERT INTO metadata_state (singleton, tag_invalidation_sequence) VALUES (1, 0);
                  CREATE TABLE pending_objects (
                    object_key TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL
                  );
                  CREATE TABLE pending_r2_tombstones (
                    key_hash TEXT PRIMARY KEY,
                    cache_key TEXT NOT NULL,
                    object_key TEXT NOT NULL,
                    revision INTEGER NOT NULL
                  ) WITHOUT ROWID;
                \`));
              }
              seed() {
                this.ctx.storage.sql.exec(
                  "INSERT INTO tag_invalidations (tag, invalidated_at) VALUES ('old-tag', 123)"
                );
                this.ctx.storage.sql.exec(
                  "INSERT INTO entries (key_hash, cache_key, active_revision, latest_revision, object_key, status_text, response_headers, fresh_until, swr_until, cache_tags, tombstoned) VALUES ('legacy-entry', '/legacy-entry', 1, 1, 'legacy-object', '', '[]', 1, 1, json_array('Legacy-Entry-Tag', 'ÜBER'), 0)"
                );
              }
            }
            export default { fetch() { return new Response("ok"); } };
          `,
          durableObjects: {
            CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
          },
        },
      ],
    });
    const legacyNamespace = await legacy.getDurableObjectNamespace(
      "CACHE_METADATA",
      "migration-worker",
    );
    await (legacyNamespace.getByName(metadataName) as any).seed();
    await legacy.dispose();
    legacy = undefined;

    upgraded = new Miniflare({
      compatibilityDate: "2026-04-08",
      compatibilityFlags: ["nodejs_compat"],
      resourcePersistencePath: persistencePath,
      unsafeEphemeralDurableObjects: true,
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: "migration-worker",
          compatibilityDate: "2026-04-08",
          compatibilityFlags: ["nodejs_compat"],
          modules: true,
          scriptPath: workerScript,
          durableObjects: {
            CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
          },
          r2Buckets: { CACHE_BODIES: "migration-test" },
          bindings: {
            CF_VERSION_METADATA: {
              id: versionId,
              tag: "test",
              timestamp: "2026-09-04T00:00:00Z",
            },
          },
        },
      ],
    });
    const purgeResponse = await upgraded.dispatchFetch("https://user.test/admin/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["ÜBER", "new-tag"] }),
    });
    assert.equal(purgeResponse.status, 200);
    assert.deepEqual(await purgeResponse.json(), {
      backingStoreUpdated: true,
      edgePurgeAccepted: false,
    });
    const storage = await upgraded.unsafeGetDurableObjectStorage(
      "migration-worker",
      "CacheMetadata",
      { name: metadataName },
    );
    assert.deepEqual(
      await storage.exec("SELECT version FROM metadata_schema_migrations ORDER BY version"),
      [
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ],
    );
    assert.deepEqual(await storage.exec("SELECT tag, key_hash FROM entry_tags"), []);
    assert.deepEqual(
      await storage.exec("SELECT tombstoned FROM entries WHERE key_hash = ?", "legacy-entry"),
      [{ tombstoned: 1 }],
    );
    assert.deepEqual(
      await storage.exec("SELECT r2_complete, edge_purge_complete FROM pending_r2_tombstones"),
      [{ edge_purge_complete: 0, r2_complete: 1 }],
    );
    const invalidations = await storage.exec(
      "SELECT tag, invalidated_at FROM tag_invalidations WHERE tag IN ('old-tag', 'new-tag') ORDER BY tag",
    );
    assert.equal(invalidations[0]?.tag, "new-tag");
    assert.ok(Number(invalidations[0]?.invalidated_at) > 123);
    assert.deepEqual(invalidations[1], { invalidated_at: 123, tag: "old-tag" });
    assert.deepEqual(
      await storage.exec("SELECT invalidation_sequence, publishable FROM pending_objects"),
      [],
    );
  } finally {
    await legacy?.dispose();
    await upgraded?.dispose();
    await rm(persistencePath, { force: true, recursive: true });
  }
});

test("retention sweep forgets expired reservations without deleting R2 objects", async () => {
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const stub = await metadataStub();
  const reservation = await stub.reserveWrite(
    "active-cleanup",
    "/active-cleanup",
    "runtime-cache/poc-v2/active-cleanup",
    Date.now(),
  );
  await bucket.put(reservation.objectKey, "active");
  const publication = await stub.publish("active-cleanup", reservation.revision, {
    objectKey: reservation.objectKey,
    statusText: "",
    responseHeaders: [],
    freshUntil: 1_000,
    swrUntil: 1_000,
    revalidator: null,
    cacheTags: [],
    fenceTags: [],
  });
  assert.equal(publication.published, true);
  const activeObjectKey = reservation.objectKey;
  const orphanObjectKey = "runtime-cache/orphaned-candidate";
  await bucket.put(orphanObjectKey, "orphan");
  await stub.trackPendingObject(activeObjectKey, 0);
  await stub.trackPendingObjects([orphanObjectKey], 0);

  assert.equal(await stub.sweepExpiredPendingObjects(1), 1);

  assert.notEqual(await bucket.head(orphanObjectKey), null);
  assert.notEqual(await bucket.head(activeObjectKey), null);
  await stub.finishPendingObjects([activeObjectKey]);

  const finishedKeys = Array.from({ length: 101 }, (_, index) => `finished-${index}`);
  await stub.trackPendingObjects(finishedKeys, 0);
  await stub.finishPendingObjects(finishedKeys);
  assert.deepEqual(await stub.listExpiredPendingObjects(1, finishedKeys.length), []);
});

test("retention cleanup uses the persistent active-object index", async () => {
  await put("/cleanup-index", "active");
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  const plan = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT pending_objects.object_key
    FROM pending_objects
    LEFT JOIN entries
      ON entries.object_key = pending_objects.object_key AND entries.tombstoned = 0
    ORDER BY pending_objects.created_at
    LIMIT 101
  `);
  const details = plan.map(({ detail }) => detail).filter((detail) => typeof detail === "string");

  assert.ok(
    details.some((detail) => detail.includes("COVERING INDEX entries_active_object_key")),
    JSON.stringify(plan),
  );
  assert.ok(
    details.every((detail) => !detail.includes("AUTOMATIC")),
    JSON.stringify(plan),
  );
});

test("retention cleanup fences an expired reservation without touching R2", async () => {
  const stub = await metadataStub();
  const createdAt = Date.now();
  const reservation = await stub.reserveWrite(
    "expired-reservation",
    "/expired-reservation",
    "runtime-cache/poc-v2/expired-reservation",
    createdAt,
  );

  assert.equal(await stub.sweepExpiredPendingObjects(createdAt + 1), 1);
  assert.equal(await metadataRowCount("pending_objects"), 0);

  const result = await stub.publish("expired-reservation", reservation.revision, {
    objectKey: reservation.objectKey,
    statusText: "",
    responseHeaders: [],
    freshUntil: 1_000,
    swrUntil: 1_000,
    revalidator: null,
    cacheTags: [],
    fenceTags: [],
  });
  assert.equal(result.published, false);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("replacement and purge clean their durable object markers", async () => {
  await put("/replacement-cleanup", "first");
  const stub = await metadataStub();
  assert.equal(await metadataRowCount("pending_objects"), 0);

  await put("/replacement-cleanup", "second");
  assert.equal(await metadataRowCount("pending_objects"), 0);
  assert.equal((await r2Objects()).objects.length, 1);

  await purge({ pathPrefixes: ["/replacement-cleanup"] });
  assert.equal(await metadataRowCount("pending_objects"), 0);
  assert.deepEqual(await stub.listExpiredPendingObjects(Date.now() + 1, 10), []);
  assert.equal((await r2Objects()).objects.length, 1);
});

test("purge tombstones an entry before a slow regeneration can publish", async () => {
  await put("/purge-race", "seed", {
    tags: ["purge-race"],
    revalidator: { body: "too-late", delayMs: 300 },
  });
  const refreshing = refreshSelectors({ tags: ["purge-race"] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await purge({ purgeEverything: true });
  const refreshResult = await refreshing;

  assert.deepEqual(refreshResult.json, { backingStoreUpdated: false, edgePurgeAccepted: false });
  assert.equal((await read("/purge-race")).status, 404);
  assert.equal((await r2Objects()).objects.length, 1);
});

test("regeneration failure retains the last durable revision", async () => {
  await put("/failure", "still-active", {
    cacheControl: "public, max-age=0",
    revalidator: { fail: true },
  });
  const failed = await read("/failure");
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /Fixture regeneration failure/);
  const entries = await metadata();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].activeRevision, 1);
  assert.equal((await r2Objects()).objects.length, 1);
});

test("a 10 MiB response body is stored in and refilled from R2", async () => {
  const size = 10 * 1024 * 1024;
  const body = new Uint8Array(size);
  body.fill(97);
  const result = await put("/large", body, { contentType: "application/octet-stream" });
  assert.equal(result.json.backingStoreUpdated, true);

  const response = await read("/large");
  assert.equal(Number(response.headers.get("Content-Length")), size);
  const returned = new Uint8Array(await response.arrayBuffer());
  assert.equal(returned.byteLength, size);
  assert.equal(returned[0], 97);
  assert.equal(returned.at(-1), 97);
});
