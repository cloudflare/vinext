import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, test, vi } from "vitest";

import { failedRegenerationHeaders } from "../src/cache-policy.js";
import type {
  ResponseStorePurgeOptions,
  ResponseStoreRefreshOptions,
  SerializableValue,
} from "../src/index.js";
import { IsolateNegativeCache } from "../src/isolate-negative-cache.js";
import { mapSettledWithR2Concurrency } from "../src/r2-concurrency.js";

const workerScript = fileURLToPath(new URL("../dist/worker/worker.js", import.meta.url));
const versionId = "poc-v2";
const metadataName = `${versionId}:r2-v1`;
const r2Root = `runtime-cache/${versionId}/r2-v1`;

type PutOptions = {
  age?: number;
  date?: string;
  expires?: string;
  lastModified?: string;
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
  if (options.date) headers.set("X-Response-Date", options.date);
  if (options.expires) headers.set("X-Response-Expires", options.expires);
  if (options.lastModified) headers.set("X-Response-Last-Modified", options.lastModified);
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

// Re-exports the fixture Worker with its R2 binding replaced. `wrapBucket` is
// the source of an expression that evaluates, once per isolate, to a function
// from the real bucket to the one the Worker uses.
async function restartWithWrappedR2Bucket(fileName: string, wrapBucket: string) {
  await mf.dispose();
  const wrapperPath = path.join(path.dirname(workerScript), fileName);
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
        modulesRoot: path.dirname(workerScript),
        modules: [
          {
            type: "ESModule",
            path: wrapperPath,
            contents: `
              import worker, { CacheMetadata, ResponseStoreRevalidator, ResponseStoreBinding as Base } from "./worker.js";
              export { CacheMetadata, ResponseStoreRevalidator };
              export default worker;
              const wrapBucket = ${wrapBucket};
              export class ResponseStoreBinding extends Base {
                constructor(ctx, env) {
                  super(ctx, { ...env, CACHE_BODIES: wrapBucket(env.CACHE_BODIES) });
                }
              }
            `,
          },
          { type: "ESModule", path: workerScript },
        ],
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
}

// Re-exports the fixture Worker with an R2 binding whose second write fails,
// either before or after the object is stored. "after-head-fails" also fails
// every HEAD, so the outcome of that write cannot be checked.
async function useFailingSecondR2Write(mode: "before" | "after" | "after-head-fails") {
  await restartWithWrappedR2Bucket(
    "failing-second-r2-write.js",
    `(() => {
      const mode = ${JSON.stringify(mode)};
      let puts = 0;
      return (bucket) => ({
        get: (...args) => bucket.get(...args),
        head: (...args) =>
          mode === "after-head-fails"
            ? Promise.reject(new Error("Injected R2 HEAD failure"))
            : bucket.head(...args),
        list: (...args) => bucket.list(...args),
        delete: (...args) => bucket.delete(...args),
        async put(key, value, options) {
          if (++puts === 2) {
            if (mode !== "before") await bucket.put(key, value, options);
            throw new Error("Injected R2 write failure");
          }
          return bucket.put(key, value, options);
        },
      });
    })()`,
  );
}

// Re-exports the fixture Worker with an R2 binding that holds its second write
// until a third one starts, then lands the second before or after the third.
// The third write's request performs both, since a request cannot use another
// request's bucket.
async function restartWithHeldSecondR2Write(order: "before" | "after") {
  await restartWithWrappedR2Bucket(
    "held-second-r2-write.js",
    `(() => {
      const order = ${JSON.stringify(order)};
      let puts = 0;
      let held;
      return (bucket) => ({
        get: (...args) => bucket.get(...args),
        head: (...args) => bucket.head(...args),
        list: (...args) => bucket.list(...args),
        delete: (...args) => bucket.delete(...args),
        async put(key, value, options) {
          const put = ++puts;
          if (put === 2) {
            return new Promise((resolve, reject) => {
              held = { key, value, options, resolve, reject };
            });
          }
          if (put !== 3) return bucket.put(key, value, options);
          const landHeld = () =>
            bucket.put(held.key, held.value, held.options).then(held.resolve, held.reject);
          if (order === "before") await landHeld();
          const stored = await bucket.put(key, value, options);
          if (order === "after") await landHeld();
          return stored;
        },
      });
    })()`,
  );
}

// Re-exports the fixture Worker with an R2 binding whose second write fails,
// as does every write while the test sets `test/fail-put`. While the test arms
// `before` or `after` for read `n`, a request's nth read of an entry's R2
// object is held before or after it reads the object, until the test releases
// it. The markers bypass the wrapper.
async function restartWithHeldEntryReads() {
  await restartWithWrappedR2Bucket(
    "held-entry-reads.js",
    `(() => {
      let puts = 0;
      return (bucket) => {
        let gets = 0;
        const hold = async (point, n) => {
          if (!(await bucket.head(\`test/arm-\${point}-\${n}\`))) return;
          await bucket.put(\`test/held-\${point}-\${n}\`, "");
          for (let wait = 0; wait < 500; wait++) {
            if (await bucket.head(\`test/release-\${point}-\${n}\`)) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        return {
          async get(key, ...args) {
            if (!key.endsWith("/active")) return bucket.get(key, ...args);
            const n = ++gets;
            await hold("before", n);
            const object = await bucket.get(key, ...args);
            await hold("after", n);
            return object;
          },
          head: (...args) => bucket.head(...args),
          list: (...args) => bucket.list(...args),
          delete: (...args) => bucket.delete(...args),
          async put(key, value, options) {
            if (++puts === 2 || (await bucket.head("test/fail-put"))) {
              throw new Error("Injected R2 write failure");
            }
            return bucket.put(key, value, options);
          },
        };
      };
    })()`,
  );
}

// Arms a hold on a request's nth entry read. `held` waits for a request to
// reach it, then disarms it so later requests read through.
async function holdEntryRead(point: "before" | "after", n: number) {
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const marker = (name: string) => `test/${name}-${point}-${n}`;
  await bucket.put(marker("arm"), "");
  return {
    async held() {
      for (let attempt = 0; attempt < 200 && !(await bucket.head(marker("held"))); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(await bucket.head(marker("held")), `entry read ${n} was not held ${point}`);
      await bucket.delete(marker("arm"));
    },
    release: () => bucket.put(marker("release"), ""),
  };
}

// Puts an entry that is past its SWR window and whose regeneration fails, and
// makes it fail once. Its re-store's R2 write is the second write, or one made
// while `test/fail-put` is set, so the re-store is fresh in the metadata while
// R2 still holds the entry hard-expired.
async function putLostHardExpiredRestore(path: string, failRestoreWrite = false) {
  await put(path, "still-active", {
    cacheControl: "public, max-age=1",
    age: 1,
    date: new Date(Date.now() - 60_000).toUTCString(),
    revalidator: { fail: true },
  });
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  if (failRestoreWrite) await bucket.put("test/fail-put", "");
  const failed = await read(path);
  assert.equal(failed.status, 500);
  await failed.arrayBuffer();
  const restored = await waitForRestore(path);
  await bucket.delete("test/fail-put");
  return restored;
}

async function regenerationCount(): Promise<number> {
  const response = await worker.fetch("https://user.test/admin/stats");
  return ((await response.json()) as { regenerationCount: number }).regenerationCount;
}

// Waits for a failed regeneration's re-store, which keeps the entry's revision
// and makes it fresh again.
async function waitForRestore(cacheKey: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entry = (await metadata()).find((candidate) => candidate.cacheKey === cacheKey);
    if (
      entry &&
      entry.freshUntil > Date.now() &&
      (await metadataRowCount("revalidation_claims")) === 0 &&
      (await metadataRowCount("pending_objects")) === 0
    ) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${cacheKey} was not re-stored`);
}

async function waitForSettledRevision(cacheKey: string, revision: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entry = (await metadata()).find((candidate) => candidate.cacheKey === cacheKey);
    if (entry?.activeRevision === revision && (await metadataRowCount("pending_objects")) === 0) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${cacheKey} did not settle at revision ${revision}`);
}

async function waitForNoPendingObjects() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await metadataRowCount("pending_objects")) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("pending objects were not settled");
}

test("bounded concurrency preserves settled results", async () => {
  let active = 0;
  let maximumActive = 0;
  const settled = await mapSettledWithR2Concurrency(
    Array.from({ length: 13 }, (_, index) => index),
    async (index) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (index === 7) throw new Error("expected failure");
      return index * 2;
    },
  );

  assert.equal(maximumActive, 6);
  assert.deepEqual(settled[0], { status: "fulfilled", value: 0 });
  assert.equal(settled[7]?.status, "rejected");
  assert.deepEqual(settled[12], { status: "fulfilled", value: 24 });
});

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

test("purgeExisting skips first writes but still purges replacements and tombstones", async () => {
  const first = await put("/conditional-edge-purge", "first", { purgeExisting: true });
  assert.deepEqual(first.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const replacement = await put("/conditional-edge-purge", "replacement", {
    purgeExisting: true,
  });
  assert.deepEqual(replacement.json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });

  await purge({ pathPrefixes: ["/conditional-edge-purge"] });
  const afterTombstone = await put("/conditional-edge-purge", "after-tombstone", {
    purgeExisting: true,
  });
  assert.deepEqual(afterTombstone.json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
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

test("a failed background regeneration re-stores the entry with clamped freshness", async () => {
  const cases = [
    {
      path: "/backoff/10",
      options: { cacheControl: "public, max-age=10, stale-while-revalidate=60", age: 10 },
      retry: 10,
      expire: 70,
      forwarded: { "Cache-Control": "public, max-age=10, stale-while-revalidate=60" },
    },
    {
      path: "/backoff/1",
      options: { cacheControl: "public, max-age=1, stale-while-revalidate=1", age: 1 },
      retry: 3,
      expire: 6,
      forwarded: { "Cache-Control": "public, max-age=1, stale-while-revalidate=1" },
    },
    {
      path: "/backoff/60",
      options: {
        cacheControl: "public, max-age=60, stale-while-revalidate=5",
        age: 60,
        date: new Date(Date.now() - 60_000).toUTCString(),
      },
      retry: 30,
      expire: 65,
      forwarded: { "Cache-Control": "public, max-age=30, stale-while-revalidate=5" },
    },
    {
      path: "/backoff/quoted",
      options: {
        cacheControl: 'public, max-age=60, stale-while-revalidate=5, ext="foo,immutable,bar"',
        age: 60,
      },
      retry: 30,
      expire: 65,
      // A quoted extension value is not split into directives.
      forwarded: {
        "Cache-Control": 'public, max-age=30, stale-while-revalidate=5, ext="foo,immutable,bar"',
      },
    },
    {
      path: "/backoff/embedded",
      options: {
        cacheControl: 'public, max-age=1, stale-while-revalidate=1, ext="x,max-age=20,y"',
        // Stale under either reading, so the retry window tells them apart.
        age: 20,
      },
      retry: 3,
      expire: 6,
      // A directive inside a quoted extension value does not set the policy.
      forwarded: {
        "Cache-Control": 'public, max-age=1, stale-while-revalidate=1, ext="x,max-age=20,y"',
      },
    },
    {
      path: "/backoff/expires",
      options: {
        cacheControl: "public",
        cloudflareCacheControl: "max-age=60, stale-while-revalidate=5",
        expires: new Date(Date.now() + 86_400_000).toUTCString(),
        age: 60,
      },
      retry: 30,
      expire: 65,
      forwarded: { "Cache-Control": "public" },
    },
    {
      path: "/backoff/heuristic",
      options: {
        cacheControl: "public",
        cloudflareCacheControl: "max-age=60, stale-while-revalidate=5",
        lastModified: new Date(Date.now() - 30 * 86_400_000).toUTCString(),
        age: 60,
      },
      retry: 30,
      expire: 65,
      // Without a lifetime of its own, a browser could derive a heuristic one
      // from Last-Modified that far outlives the retry window.
      forwarded: { "Cache-Control": "public, max-age=30" },
    },
    {
      path: "/backoff/static",
      options: {
        cacheControl: "public, max-age=31536000, immutable",
        cloudflareCacheControl: "max-age=31536000, stale-while-revalidate=60",
        age: 31_536_000,
      },
      retry: 3,
      expire: 31_536_060,
      forwarded: { "Cache-Control": "public, max-age=3" },
    },
    {
      path: "/backoff/cdn",
      options: {
        cacheControl: "public, max-age=100, stale-while-revalidate=100",
        cdnCacheControl: "max-age=10, stale-while-revalidate=20",
        age: 10,
      },
      retry: 10,
      expire: 30,
      forwarded: {
        "Cache-Control": "public, max-age=10, stale-while-revalidate=100",
        "CDN-Cache-Control": "max-age=10, stale-while-revalidate=20",
      },
    },
  ];

  for (const { path, options, retry, expire, forwarded } of cases) {
    await put(path, `stale:${path}`, { ...options, revalidator: { fail: true } });
    const stale = await read(path);
    assert.equal(stale.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
    assert.equal(await stale.text(), `stale:${path}`);

    const entry = await waitForRestore(path);
    assert.equal(entry.activeRevision, 1);
    assert.equal(entry.swrUntil - entry.freshUntil, (expire - retry) * 1000);
    // The metadata row keeps the original policy for the next failure.
    assert.deepEqual(
      entry.responseHeaders.find(([name]: [string, string]) => name === "cache-control")?.[1],
      options.cacheControl ?? "public, max-age=60, stale-while-revalidate=60",
    );
    const remaining = entry.freshUntil - Date.now();
    assert.ok(remaining > (retry - 2) * 1000 && remaining <= retry * 1000, `${path}: ${remaining}`);
    assert.equal(await metadataRowCount("revalidation_claims"), 0);

    const fresh = await read(path);
    assert.equal(fresh.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
    assert.equal(fresh.headers.get("X-Workers-Response-Store-Revision"), "1");
    assert.match(
      fresh.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      new RegExp(`^max-age=(${retry - 1}|${retry}), stale-while-revalidate=${expire - retry}$`),
    );
    // The re-store starts the entry's age again, so the edge can use the
    // retry window instead of treating the response as already stale.
    assert.match(fresh.headers.get("Age") ?? "", /^[01]$/, path);
    // Forwarded freshness is capped at the retry window too, so downstream
    // caches cannot hide the next retry.
    for (const [name, value] of Object.entries(forwarded)) {
      assert.equal(fresh.headers.get(name), value, `${path}: ${name}`);
    }
    // A stored Date moves to the re-store time as well, so shared caches do
    // not derive an older apparent age from it.
    if ("date" in options) {
      const date = Date.parse(fresh.headers.get("Date") ?? "");
      assert.ok(Math.abs(Date.now() - date) < 3000, `${path}: ${fresh.headers.get("Date")}`);
    }
    // A later Expires is capped too; a browser falls back to it without a max-age.
    if ("expires" in options) {
      const expires = Date.parse(fresh.headers.get("Expires") ?? "");
      assert.ok(expires <= Date.now() + retry * 1000, `${path}: ${fresh.headers.get("Expires")}`);
    }
    assert.equal(await fresh.text(), `stale:${path}`);
  }

  assert.equal(await regenerationCount(), cases.length);
  assert.equal((await r2Objects()).objects.length, cases.length);
});

test("a failed background regeneration backs off before retrying", async () => {
  await put("/stale-retry", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: {
      body: "retry-succeeded",
      cacheControl: "public, max-age=60",
      failOnce: true,
    },
  });

  assert.equal(await (await read("/stale-retry")).text(), "stale-body");
  await waitForRestore("/stale-retry");
  const backingOff = await read("/stale-retry");
  assert.equal(backingOff.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(await backingOff.text(), "stale-body");
  assert.equal(await regenerationCount(), 1);

  await new Promise((resolve) => setTimeout(resolve, 3100));
  const retrying = await read("/stale-retry");
  assert.equal(retrying.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(await retrying.text(), "stale-body");
  await waitForSettledRevision("/stale-retry", 3);
  assert.equal(await (await read("/stale-retry")).text(), "retry-succeeded");
  assert.equal(await regenerationCount(), 2);
});

test("a re-store's retry window starts once its source body is read", async () => {
  // Buffering an entry's R2 body takes longer than the 3 s retry window.
  await restartWithWrappedR2Bucket(
    "slow-restore-source.js",
    `(bucket) => ({
      async get(key, ...args) {
        const object = await bucket.get(key, ...args);
        if (!object) return object;
        const { body, customMetadata, etag, size } = object;
        return {
          body,
          customMetadata,
          etag,
          size,
          async arrayBuffer() {
            await new Promise((resolve) => setTimeout(resolve, 3500));
            return object.arrayBuffer();
          },
        };
      },
      head: (...args) => bucket.head(...args),
      list: (...args) => bucket.list(...args),
      delete: (...args) => bucket.delete(...args),
      put: (...args) => bucket.put(...args),
    })`,
  );
  const path = "/restore-slow-source";
  await put(path, "stale-body", {
    cacheControl: "public, max-age=1, stale-while-revalidate=30",
    age: 1,
    date: new Date(Date.now() - 60_000).toUTCString(),
    revalidator: { fail: true },
  });
  const stale = await read(path);
  assert.equal(stale.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(await stale.text(), "stale-body");

  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  let entry: any;
  for (let attempt = 0; attempt < 300; attempt++) {
    entry = (await metadata()).find((candidate) => candidate.cacheKey === path);
    const object = await bucket.head(`${r2Root}/${entry.keyHash}/active`);
    if (
      (await regenerationCount()) === 1 &&
      (await metadataRowCount("revalidation_claims")) === 0 &&
      object?.customMetadata?.freshUntil === String(entry.freshUntil)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const remaining = entry.freshUntil - Date.now();
  assert.ok(remaining > 2000, `retry window remaining: ${remaining}`);

  const fresh = await read(path);
  assert.equal(fresh.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(
    fresh.headers.get("X-Workers-Response-Store-Age-Basis"),
    `${entry.freshUntil - 3000}:0`,
  );
  assert.equal(fresh.headers.get("Date"), new Date(entry.freshUntil - 3000).toUTCString());
  assert.equal(fresh.headers.get("Age"), "0");
  assert.equal(await fresh.text(), "stale-body");
  assert.equal(await regenerationCount(), 1);
});

test("a re-store caps only a valid HTTP-date Expires", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const retryUntil = new Date(now + 3000).toUTCString();
  const expires = (value: string) =>
    failedRegenerationHeaders([["Expires", value]], 3, now).find(
      ([name]) => name === "Expires",
    )?.[1];

  // A later date in any of the three RFC 9110 formats moves to the retry window.
  assert.equal(expires("Thu, 01 Jan 2099 00:00:00 GMT"), retryUntil);
  assert.equal(expires("Friday, 01-Jan-49 00:00:00 GMT"), retryUntil);
  assert.equal(expires("Thu Jan  1 00:00:00 2099"), retryUntil);
  // A leap second is in range.
  assert.equal(expires("Thu, 01 Jan 2099 23:59:60 GMT"), retryUntil);
  // These are not valid HTTP-dates, even where `Date.parse` reads them as
  // 2099, so they already mean expired and stay as they are.
  for (const invalid of [
    "2099-01-01",
    "Thu, 01 Jan 2099 00:00:00 +0000",
    "thu, 01 jan 2099 00:00:00 GMT",
    // Out-of-range fields that `Date` would roll forward: 31 Feb is read as
    // Tuesday 3 Mar, and hour 99 as 5 Jan.
    "Tue, 31 Feb 2099 00:00:00 GMT",
    "Tue Feb 31 00:00:00 2099",
    "Thu, 01 Jan 2099 99:00:00 GMT",
    "Thu, 01 Jan 2099 00:60:00 GMT",
    "Thu, 01 Jan 2099 00:00:61 GMT",
    // 1 Jan 2099 and 1 Jan 2049 are not on these weekdays.
    "Fri, 01 Jan 2099 00:00:00 GMT",
    "Thursday, 01-Jan-49 00:00:00 GMT",
  ]) {
    assert.equal(expires(invalid), invalid);
  }
  // A two-digit year more than 50 years ahead is in the past.
  assert.equal(expires("Friday, 01-Jan-99 00:00:00 GMT"), "Friday, 01-Jan-99 00:00:00 GMT");
});

test("an entry past its SWR window keeps serving after a failed foreground regeneration", async () => {
  await put("/failure", "still-active", {
    cacheControl: "s-maxage=31536000, stale-while-revalidate",
    age: 31_536_000,
    revalidator: { fail: true },
  });

  const failed = await read("/failure");
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /Fixture regeneration failure/);
  const entries = await metadata();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].activeRevision, 1);
  assert.equal((await r2Objects()).objects.length, 1);

  for (let attempt = 0; attempt < 3; attempt++) {
    const served = await read("/failure");
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
    assert.match(
      served.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /^max-age=[23], stale-while-revalidate=0$/,
    );
    assert.match(served.headers.get("Age") ?? "", /^[01]$/);
    assert.equal(await served.text(), "still-active");
  }
  assert.equal(await regenerationCount(), 1);
});

test("a regeneration whose body fails midway backs off in the background", async () => {
  await put("/mid-body/background", "stale-body", {
    cacheControl: "public, max-age=10, stale-while-revalidate=60",
    age: 10,
    revalidator: { failMidBody: true },
  });

  assert.equal(await (await read("/mid-body/background")).text(), "stale-body");
  const entry = await waitForRestore("/mid-body/background");
  assert.equal(entry.swrUntil - entry.freshUntil, 60_000);
  assert.equal(await metadataRowCount("revalidation_claims"), 0);

  const fresh = await read("/mid-body/background");
  assert.equal(fresh.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.match(
    fresh.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=(9|10), stale-while-revalidate=60$/,
  );
  assert.equal(await fresh.text(), "stale-body");
  assert.equal(await regenerationCount(), 1);
});

test("a foreground regeneration whose body fails midway returns the error and backs off", async () => {
  await put("/mid-body/foreground", "still-active", {
    cacheControl: "public, max-age=1",
    age: 1,
    revalidator: { failMidBody: true },
  });

  const failed = await read("/mid-body/foreground");
  assert.equal(failed.status, 500);
  // RPC reports a stream that errors as a premature disconnect.
  assert.match(await failed.text(), /ReadableStream received over RPC disconnected prematurely/);
  const [entry] = await metadata();
  assert.equal(entry.activeRevision, 1);
  assert.ok(entry.freshUntil > Date.now());
  assert.equal(await metadataRowCount("pending_objects"), 0);

  const served = await read("/mid-body/foreground");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.match(
    served.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /^max-age=[23], stale-while-revalidate=3$/,
  );
  assert.equal(await served.text(), "still-active");
  assert.equal(await regenerationCount(), 1);
});

test("a failed regeneration does not make a non-reusable entry fresh", async () => {
  const cases = [
    { path: "/no-reuse/private", cacheControl: "private, max-age=60, stale-while-revalidate=60" },
    { path: "/no-reuse/no-store", cacheControl: "no-store, max-age=60, stale-while-revalidate=60" },
    { path: "/no-reuse/no-cache", cacheControl: "public, no-cache, stale-while-revalidate=30" },
    { path: "/no-reuse/zero", cacheControl: "public, max-age=0" },
  ];
  let regenerations = 0;

  async function readAfterFailedRegeneration(path: string) {
    const response = await read(path);
    assert.doesNotMatch(
      response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /max-age=[1-9]/,
      path,
    );
    if (response.status === 500) {
      assert.match(await response.text(), /Fixture regeneration failure/);
    } else {
      assert.equal(response.headers.get("X-Workers-Response-Store"), "BLOB-STALE", path);
      assert.equal(await response.text(), "must-stay-stale");
    }
    regenerations++;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await regenerationCount()) === regenerations &&
        (await metadataRowCount("pending_objects")) === 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await regenerationCount(), regenerations);
    await waitForSettledRevision(path, 1);
    assert.equal(await metadataRowCount("revalidation_claims"), 0);
  }

  for (const { path, cacheControl } of cases) {
    await put(path, "must-stay-stale", { cacheControl, revalidator: { fail: true } });
    // The failed regeneration leaves the entry as it was, so the next read
    // regenerates again instead of serving it as fresh.
    await readAfterFailedRegeneration(path);
    await readAfterFailedRegeneration(path);
  }
});

test("a failed regeneration keeps policies that forbid stale serving hard-expiring", async () => {
  const cases = [
    { path: "/no-stale/must-revalidate", cacheControl: "public, max-age=1, must-revalidate" },
    {
      path: "/no-stale/proxy-revalidate",
      cacheControl: "public, max-age=1, proxy-revalidate, stale-while-revalidate=30",
    },
    { path: "/no-stale/s-maxage", cacheControl: "public, s-maxage=1, stale-while-revalidate=30" },
  ];

  for (const { path, cacheControl } of cases) {
    await put(path, "no-stale", { cacheControl, age: 1, revalidator: { fail: true } });
    const failed = await read(path);
    assert.equal(failed.status, 500, path);
    await failed.arrayBuffer();

    const entry = (await metadata()).find((candidate) => candidate.cacheKey === path);
    assert.equal(entry.activeRevision, 1, path);
    assert.equal(entry.swrUntil, entry.freshUntil, path);
    const served = await read(path);
    assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH", path);
    assert.match(
      served.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /^max-age=[23], stale-while-revalidate=0$/,
    );
    assert.equal(await served.text(), "no-stale");
  }

  await new Promise((resolve) => setTimeout(resolve, 3100));
  const expired = await read("/no-stale/must-revalidate");
  assert.equal(expired.status, 500);
  assert.match(await expired.text(), /Fixture regeneration failure/);
  assert.equal(await regenerationCount(), cases.length + 1);
});

test("a re-store whose R2 rewrite fails leaves the source revision readable", async () => {
  await useFailingSecondR2Write("before");
  await put("/restore-write-lost", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: { fail: true },
  });

  assert.equal(await (await read("/restore-write-lost")).text(), "stale-body");
  const entry = await waitForRestore("/restore-write-lost");
  assert.equal(entry.activeRevision, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 0);

  const served = await read("/restore-write-lost");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(served.headers.get("X-Workers-Response-Store-Revision"), "1");
  assert.equal(await served.text(), "stale-body");
  // The metadata still matches the R2 revision, so once the retry window ends
  // a stale read claims a retry.
  await new Promise((resolve) => setTimeout(resolve, entry.freshUntil - Date.now() + 100));
  assert.equal(await regenerationCount(), 1);
  const retrying = await read("/restore-write-lost");
  assert.equal(retrying.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  await retrying.arrayBuffer();
  for (let attempt = 0; attempt < 100 && (await regenerationCount()) < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await regenerationCount(), 2);
});

test("a hard-expired entry whose re-store write fails is served as re-stored", async () => {
  await useFailingSecondR2Write("before");
  const options = {
    cacheControl: "public, max-age=1",
    age: 1,
    date: new Date(Date.now() - 60_000).toUTCString(),
    revalidator: { fail: true },
  };
  // The first entry's re-store write fails; the second one's lands.
  const entries: any[] = [];
  for (const path of ["/restore-hard-expired/lost", "/restore-hard-expired/landed"]) {
    await put(path, "still-active", options);
    const failed = await read(path);
    assert.equal(failed.status, 500);
    await failed.arrayBuffer();
    entries.push(await waitForRestore(path));
  }
  const lostObject = await (
    await mf.getR2Bucket("CACHE_BODIES", "user-worker")
  ).head(`${r2Root}/${entries[0].keyHash}/active`);
  assert.notEqual(lostObject?.customMetadata?.freshUntil, String(entries[0].freshUntil));

  // Inside the retry window, the entry whose R2 object is still hard-expired
  // is served without regenerating, exactly as the rewritten one is.
  const [lost, landed] = await Promise.all([
    read("/restore-hard-expired/lost"),
    read("/restore-hard-expired/landed"),
  ]);
  const timing = new Set([
    "age",
    "cache-tag",
    "cloudflare-cdn-cache-control",
    "date",
    "x-workers-response-store-age-basis",
    "x-workers-response-store-binding-invocation",
  ]);
  const comparable = (response: Response) =>
    [...response.headers].filter(([name]) => !timing.has(name));
  assert.equal(lost.status, 200);
  assert.deepEqual(comparable(lost), comparable(landed));
  for (const [index, response] of [lost, landed].entries()) {
    const restoredAt = entries[index].freshUntil - 3_000;
    assert.equal(response.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
    assert.equal(response.headers.get("X-Workers-Response-Store-Age-Basis"), `${restoredAt}:0`);
    assert.equal(response.headers.get("Date"), new Date(restoredAt).toUTCString());
    assert.match(response.headers.get("Age") ?? "", /^[0-3]$/);
    assert.match(
      response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /^max-age=[1-3], stale-while-revalidate=3$/,
    );
    assert.equal(await response.text(), "still-active");
  }
  assert.equal(await regenerationCount(), 2);

  // Manual refresh still regenerates inside the retry window.
  await refreshSelectors({ pathPrefixes: ["/restore-hard-expired/lost"] });
  assert.equal(await regenerationCount(), 3);
});

// A write that replaces the revision is handled as a new read would handle it.
const overtakingWrites = [
  {
    name: "a fresh write is served",
    cacheControl: "public, max-age=60, stale-while-revalidate=60",
    status: "BLOB-FRESH",
    regenerated: false,
  },
  {
    name: "a stale write is served and refreshed in the background",
    cacheControl: "public, max-age=0, stale-while-revalidate=60",
    status: "BLOB-STALE",
    regenerated: true,
  },
  {
    name: "a no-store write is regenerated",
    cacheControl: "no-store",
    status: null,
    regenerated: true,
  },
];

for (const { name, cacheControl, status, regenerated } of overtakingWrites) {
  test(`a write that lands while a hard-expired read serves a re-store: ${name}`, async () => {
    await restartWithHeldEntryReads();
    const path = "/restore-hard-expired/overtaken";
    await putLostHardExpiredRestore(path);
    assert.equal(await regenerationCount(), 1);

    // The read finds the retry window in the metadata, then a new write lands
    // before it reads the re-store's body.
    const bodyRead = await holdEntryRead("before", 2);
    const reading = read(path);
    await bodyRead.held();
    await put(path, "newer-write", { cacheControl, revalidator: { bodyPrefix: "regenerated" } });
    const written = (await metadata()).find((candidate) => candidate.cacheKey === path);
    await bodyRead.release();

    const served = await reading;
    assert.equal(served.status, 200);
    if (status) {
      assert.equal(served.headers.get("X-Workers-Response-Store"), status);
      assert.equal(
        served.headers.get("X-Workers-Response-Store-Revision"),
        String(written.activeRevision),
      );
      assert.equal(await served.text(), "newer-write");
    } else {
      // The write may not be reused, so it is regenerated in the foreground.
      assert.equal(served.headers.get("X-Revalidation-Reason"), "expired");
      assert.match(await served.text(), /^regenerated:2:/);
    }

    const settledRevision = written.activeRevision + (regenerated ? 1 : 0);
    const entry = await waitForSettledRevision(path, settledRevision);
    assert.equal(entry.latestRevision, settledRevision);
    assert.equal(await regenerationCount(), regenerated ? 2 : 1);
  });
}

test("a re-read replacement is not regenerated over a write that lands before its reservation", async () => {
  await restartWithHeldEntryReads();
  const path = "/restore-hard-expired/reread-overtaken";
  await putLostHardExpiredRestore(path);

  // A no-store write replaces the re-store while the read waits to read its
  // body, so the read reads R2 again and finds that write, which it has to
  // regenerate. A fresh write lands before it reserves the regeneration.
  const bodyRead = await holdEntryRead("before", 2);
  const reading = read(path);
  await bodyRead.held();
  await put(path, "no-store-write", {
    cacheControl: "no-store",
    revalidator: { bodyPrefix: "regenerated" },
  });
  const reread = await holdEntryRead("after", 3);
  await bodyRead.release();
  await reread.held();
  await put(path, "fresh-write", { revalidator: { bodyPrefix: "regenerated" } });
  const written = (await metadata()).find((candidate) => candidate.cacheKey === path);
  await reread.release();

  const served = await reading;
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(
    served.headers.get("X-Workers-Response-Store-Revision"),
    String(written.activeRevision),
  );
  assert.equal(await served.text(), "fresh-write");
  await waitForSettledRevision(path, written.activeRevision);
  assert.equal(await regenerationCount(), 1);
});

test("a re-read replacement's own replacement is read again rather than missed", async () => {
  await restartWithHeldEntryReads();
  const path = "/restore-hard-expired/reread-replaced";
  await putLostHardExpiredRestore(path);

  // While the read waits to read the re-store's body, another hard-expired
  // write replaces it and gets a lost re-store of its own, so the read reads
  // R2 again and finds that re-store's retry window too.
  const bodyRead = await holdEntryRead("before", 2);
  const reading = read(path);
  await bodyRead.held();
  await putLostHardExpiredRestore(path, true);
  assert.equal(await regenerationCount(), 2);

  // A fresh write then replaces that re-store before the read reads its body.
  const replacementBodyRead = await holdEntryRead("before", 4);
  await bodyRead.release();
  await replacementBodyRead.held();
  await put(path, "fresh-write", { revalidator: { bodyPrefix: "regenerated" } });
  const written = (await metadata()).find((candidate) => candidate.cacheKey === path);
  await replacementBodyRead.release();

  const served = await reading;
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(
    served.headers.get("X-Workers-Response-Store-Revision"),
    String(written.activeRevision),
  );
  assert.equal(await served.text(), "fresh-write");
  await waitForSettledRevision(path, written.activeRevision);
  assert.equal(await regenerationCount(), 2);
});

test("a re-store whose R2 rewrite lands before reporting failure keeps it", async () => {
  await useFailingSecondR2Write("after");
  await put("/restore-write-landed", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: { fail: true },
  });

  assert.equal(await (await read("/restore-write-landed")).text(), "stale-body");
  await waitForRestore("/restore-write-landed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 0);

  const served = await read("/restore-write-landed");
  assert.equal(served.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(served.headers.get("X-Workers-Response-Store-Revision"), "1");
  assert.equal(await served.text(), "stale-body");
  assert.equal(await regenerationCount(), 1);
});

test("an unverifiable re-store outcome does not disable later regeneration", async () => {
  await useFailingSecondR2Write("after-head-fails");
  await put("/restore-write-unverified", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    revalidator: { fail: true },
  });

  assert.equal(await (await read("/restore-write-unverified")).text(), "stale-body");
  await waitForRestore("/restore-write-unverified");
  await new Promise((resolve) => setTimeout(resolve, 3100));

  const stale = await read("/restore-write-unverified");
  assert.equal(stale.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(await stale.text(), "stale-body");
  for (let attempt = 0; attempt < 100 && (await regenerationCount()) < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await regenerationCount(), 2);
});

test("a failed re-store keeps the regeneration error and releases its reservation", async () => {
  await put("/republish-failure", "still-active", {
    cacheControl: "public, max-age=1",
    age: 1,
    revalidator: { fail: true },
  });
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  await storage.exec("DROP TABLE entry_tags");

  const failed = await read("/republish-failure");
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /Fixture regeneration failure/);
  assert.equal((await metadata())[0].activeRevision, 1);
  assert.equal(await metadataRowCount("pending_objects"), 0);
  assert.equal(await metadataRowCount("revalidation_claims"), 0);
});

test("a failed regeneration does not replace a newer concurrent write", async () => {
  await put("/republish-race", "old", {
    cacheControl: "public, max-age=1",
    age: 1,
    revalidator: { fail: true, delayMs: 300 },
  });
  const newer = put("/republish-race", "newer", { bodyDelayMs: 150 });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("pending_objects")) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await metadataRowCount("pending_objects"), 1);

  const failed = await read("/republish-race");
  assert.equal(failed.status, 500);
  assert.equal((await newer).json.backingStoreUpdated, true);
  await waitForNoPendingObjects();

  const [entry] = await metadata();
  assert.equal(entry.activeRevision, 2);
  assert.equal(await (await read("/republish-race")).text(), "newer");
});

test("a failed regeneration does not undo a concurrent tag purge", async () => {
  await put("/republish-purge", "purged", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    tags: ["republish-purge"],
    revalidator: { fail: true, delayMs: 300 },
  });
  assert.equal(await (await read("/republish-purge")).text(), "purged");
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await metadataRowCount("revalidation_claims")) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await metadataRowCount("revalidation_claims"), 1);

  await purge({ tags: ["republish-purge"] });
  await waitForNoPendingObjects();
  assert.equal(await regenerationCount(), 1);
  assert.deepEqual(await metadata(), []);
  assert.equal((await read("/republish-purge")).status, 404);
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

test("refresh candidate selection returns only reservation fields", async () => {
  const path = "/refresh-candidate-projection";
  await put(path, "seed", {
    largeHeaderBytes: 16_000,
    revalidator: { body: "refreshed", cacheControl: "public, max-age=60" },
  });

  const metadata = await metadataStub();
  const options = { pathPrefixes: [path] };
  assert.deepEqual(await metadata.findRefreshCandidates(options, "reservation"), [
    {
      keyHash: await cacheKeyHash(path),
      cacheKey: path,
      activeRevision: 1,
      latestRevision: 1,
      hasRevalidator: true,
    },
  ]);
  assert.deepEqual((await metadata.findRefreshCandidates(options))[0]?.revalidator, {
    id: "fixture-render",
    args: [{ body: "refreshed", cacheControl: "public, max-age=60" }],
  });
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

test("manual refresh handles more than one hundred candidates", async () => {
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

test("manual refresh reserves candidates only as concurrency slots become available", async () => {
  const candidateCount = 13;
  await Promise.all(
    Array.from({ length: candidateCount }, (_, index) =>
      put(`/refresh-reservation-window/${index}`, `seed-${index}`, {
        tags: ["refresh-reservation-window"],
        revalidator: {
          body: `refreshed-${index}`,
          cacheControl: "public, max-age=60",
          delayMs: 500,
        },
      }),
    ),
  );

  const refreshing = refreshSelectors({ tags: ["refresh-reservation-window"] });
  let activePaths: string[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await worker.fetch("https://user.test/admin/active-regenerations");
    activePaths = (await response.json()) as string[];
    if (activePaths.length === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(activePaths.length, 6);

  const activeObjectKeys = await Promise.all(
    activePaths.map(async (path) => `${r2Root}/${await cacheKeyHash(path)}/2`),
  );
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  await storage.exec(
    `UPDATE pending_objects SET created_at = CASE
      WHEN object_key IN (${activeObjectKeys.map(() => "?").join(", ")}) THEN ? ELSE 0 END`,
    ...activeObjectKeys,
    Date.now(),
  );

  const swept = await (await metadataStub()).sweepExpiredPendingObjects(1);
  const result = await refreshing;
  assert.equal(swept, 0);
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: false });
  assert.equal(
    (await metadata()).filter((entry) => entry.activeRevision === 2).length,
    candidateCount,
  );
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("manual refresh does not regenerate a replacement outside its selected revision", async () => {
  const paths = Array.from({ length: 7 }, (_, index) => `/refresh-replacement/${index}`);
  await Promise.all(
    paths.map((path, index) =>
      put(path, `seed-${index}`, {
        tags: ["refresh-replacement"],
        revalidator: {
          body: `refreshed-${index}`,
          cacheControl: "public, max-age=60",
          delayMs: 300,
        },
      }),
    ),
  );

  const refreshing = refreshSelectors({ tags: ["refresh-replacement"] });
  let activePaths: string[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await worker.fetch("https://user.test/admin/active-regenerations");
    activePaths = (await response.json()) as string[];
    if (activePaths.length === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(activePaths.length, 6);

  const queuedPath = paths.find((path) => !activePaths.includes(path));
  assert.ok(queuedPath);
  const replacement = put(queuedPath, "replacement", { bodyDelayMs: 600 });
  let replacementReserved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const queuedEntry = (await metadata()).find((entry) => entry.cacheKey === queuedPath);
    if (queuedEntry?.latestRevision === 2) {
      replacementReserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(replacementReserved, true);

  const [refreshResult, replacementResult] = await Promise.all([refreshing, replacement]);
  assert.deepEqual(refreshResult.json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });
  assert.deepEqual(replacementResult.json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  assert.equal(await (await read(queuedPath)).text(), "replacement");
  assert.equal(await metadataRowCount("pending_objects"), 0);
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

test("path-prefix selection uses the cache-key index", async () => {
  await put("/indexed-prefix/a", "a");
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  const plan = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT entries.key_hash FROM entries
    WHERE entries.key_hash IN (
      SELECT path_entry.key_hash FROM json_each('["/indexed-prefix"]') AS path_prefix
      JOIN entries AS path_entry
        ON path_entry.cache_key >= path_prefix.value
        AND path_entry.cache_key < path_prefix.value || char(127)
    )
  `);
  const details = plan.map(({ detail }) => detail).filter((detail) => typeof detail === "string");

  assert.ok(
    details.some((detail) => detail.includes("INDEX entries_cache_key")),
    JSON.stringify(plan),
  );
  assert.ok(
    details.every((detail) => !detail.includes("SCAN path_entry")),
    JSON.stringify(plan),
  );
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
  assert.equal(retry.pendingTombstones, 0);
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

test("stale edge completion cannot remove a replacement tombstone", async () => {
  await put("/stale-edge-completion", "first", { tags: ["stale-edge-completion"] });
  const stub = await metadataStub();

  await stub.purgeMatching({ tags: ["stale-edge-completion"] });
  const first = await stub.drainPendingTombstones(1);
  assert.equal(first.purged.length, 1);

  await put("/stale-edge-completion", "second", { tags: ["stale-edge-completion"] });
  await stub.purgeMatching({ tags: ["stale-edge-completion"] });
  await stub.markTombstonesEdgePurged(first.purged);

  assert.equal(await metadataRowCount("pending_r2_tombstones"), 1);
  const replacement = await stub.drainPendingTombstones(1);
  assert.equal(replacement.purged.length, 1);
  assert.ok(replacement.purged[0].revision > first.purged[0].revision);
  await stub.markTombstonesEdgePurged(replacement.purged);
  assert.equal(await metadataRowCount("pending_r2_tombstones"), 0);
});

test("purge only drains R2 and edge work from its snapshot", async () => {
  const stub = await metadataStub();
  await stub.inspect();
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });
  await storage.exec(`
    WITH RECURSIVE numbers(value) AS (
      VALUES(0)
      UNION ALL
      SELECT value + 1 FROM numbers WHERE value < 400
    )
    INSERT INTO pending_r2_tombstones
      (key_hash, cache_key, object_key, revision, r2_complete, tombstone_sequence)
    SELECT
      printf('historical-r2-%03d', value),
      printf('/historical-r2/%d', value),
      printf('historical-r2-object-%d', value),
      1,
      0,
      1
    FROM numbers
  `);
  await storage.exec(`
    WITH RECURSIVE numbers(value) AS (
      VALUES(0)
      UNION ALL
      SELECT value + 1 FROM numbers WHERE value < 400
    )
    INSERT INTO pending_r2_tombstones
      (key_hash, cache_key, object_key, revision, r2_complete, tombstone_sequence)
    SELECT
      printf('historical-edge-%03d', value),
      printf('/historical-edge/%d', value),
      printf('historical-edge-object-%d', value),
      1,
      1,
      2
    FROM numbers
  `);
  await storage.exec("UPDATE metadata_state SET tombstone_sequence = 2 WHERE singleton = 1");

  await put("/current-purge", "current", { tags: ["current-purge"] });
  assert.deepEqual((await purge({ tags: ["current-purge"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });

  assert.deepEqual(
    await storage.exec(
      `SELECT r2_complete, edge_purge_complete, tombstone_sequence
      FROM pending_r2_tombstones WHERE cache_key = '/current-purge'`,
    ),
    [{ edge_purge_complete: 0, r2_complete: 1, tombstone_sequence: 3 }],
  );
  assert.deepEqual(
    await storage.exec(
      `SELECT COUNT(*) AS count FROM pending_r2_tombstones
      WHERE tombstone_sequence = 1 AND r2_complete = 0`,
    ),
    [{ count: 401 }],
  );
  assert.deepEqual(
    (await stub.listPendingEdgePurges(400, 3)).map(
      ({ cacheKey }: { cacheKey: string }) => cacheKey,
    ),
    ["/current-purge"],
  );
  assert.equal((await stub.listPendingEdgePurges(400, 2)).length, 400);
});

test("snapshot draining preserves tombstones created by a concurrent later purge", async () => {
  await put("/snapshot-current", "current", { tags: ["snapshot-current"] });
  await put("/snapshot-later", "later", { tags: ["snapshot-later"] });
  const stub = await metadataStub();

  const current = await stub.purgeMatching({ tags: ["snapshot-current"] });
  const later = await stub.purgeMatching({ tags: ["snapshot-later"] });
  const drained = await stub.drainPendingTombstones(
    400,
    undefined,
    undefined,
    current.tombstoneSequence,
  );

  assert.deepEqual(
    drained.pending.map(({ cacheKey }: { cacheKey: string }) => cacheKey),
    ["/snapshot-current"],
  );
  assert.deepEqual(
    (await stub.listPendingEdgePurges(400, current.tombstoneSequence)).map(
      ({ cacheKey }: { cacheKey: string }) => cacheKey,
    ),
    ["/snapshot-current"],
  );
  assert.equal(
    (await stub.drainPendingTombstones(400, undefined, undefined, later.tombstoneSequence))
      .pending[0].cacheKey,
    "/snapshot-later",
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

test("an overlapping first-write reservation still purges when it replaces a publication", async () => {
  const first = put("/overlapping-first-write", "first", {
    bodyDelayMs: 150,
    purgeExisting: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const replacement = put("/overlapping-first-write", "replacement", {
    bodyDelayMs: 300,
    purgeExisting: true,
  });

  assert.deepEqual((await first).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: true,
  });
  assert.deepEqual((await replacement).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/overlapping-first-write")).text(), "replacement");
});

test("overlapping first writes can be coalesced without an edge purge", async () => {
  const first = put("/coalesced", "first", {
    bodyDelayMs: 300,
    coalesce: true,
    purgeExisting: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await put("/coalesced", "second", {
    coalesce: true,
    purgeExisting: true,
  });
  const firstResult = await first;

  assert.deepEqual(firstResult.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.deepEqual(second.json, { backingStoreUpdated: true, edgePurgeAccepted: true });
  assert.equal(await (await read("/coalesced")).text(), "first");
  assert.equal((await metadata())[0].activeRevision, 1);
  assert.equal((await r2Objects()).objects.length, 1);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("coalesced replacements still purge the existing edge response", async () => {
  await put("/coalesced-replacement", "seed");
  const first = put("/coalesced-replacement", "first", {
    bodyDelayMs: 300,
    coalesce: true,
    purgeExisting: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = put("/coalesced-replacement", "second", {
    coalesce: true,
    purgeExisting: true,
  });

  assert.deepEqual((await first).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.deepEqual((await second).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/coalesced-replacement")).text(), "first");
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
    edgePurgeAccepted: true,
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
    purgeExisting: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fallback = put("/coalesced-fallback", "succeeds", {
    coalesce: true,
    purgeExisting: true,
  });

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
    entry.freshUntil,
    1,
  );
  const second = await stub.claimRevalidation(
    entry.keyHash,
    entry.activeRevision,
    entry.cacheKey,
    "runtime-cache/poc-v2/claim-replacement",
    entry.freshUntil + 2,
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
    entry.freshUntil,
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

test("a re-store cannot publish once its source revision is replaced", async () => {
  await put("/expected-active-revision", "seed");
  const [entry] = await metadata();
  const stub = await metadataStub();
  const prefix = "runtime-cache/poc-v2/expected-active-revision";
  const newer = await stub.reserveWrite(entry.keyHash, entry.cacheKey, prefix, Date.now());
  const restore = await stub.reserveWrite(entry.keyHash, entry.cacheKey, prefix, Date.now());

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
      await stub.publish(entry.keyHash, newer.revision, {
        ...candidate,
        objectKey: newer.objectKey,
      })
    ).published,
    true,
  );
  assert.equal(
    (
      await stub.publish(
        entry.keyHash,
        restore.revision,
        { ...candidate, objectKey: restore.objectKey },
        undefined,
        restore.objectKey,
        entry,
      )
    ).published,
    false,
  );
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("only the first re-store of a source state publishes", async () => {
  await put("/single-restore", "seed");
  const [entry] = await metadata();
  const stub = await metadataStub();
  const prefix = "runtime-cache/poc-v2/single-restore";
  const first = await stub.reserveWrite(entry.keyHash, entry.cacheKey, prefix, Date.now());
  const second = await stub.reserveWrite(entry.keyHash, entry.cacheKey, prefix, Date.now());
  const source = {
    activeRevision: entry.activeRevision,
    freshUntil: entry.freshUntil,
    swrUntil: entry.swrUntil,
  };
  const candidate = {
    statusText: entry.statusText,
    responseHeaders: entry.responseHeaders,
    revalidator: entry.revalidator,
    cacheTags: [],
    fenceTags: [],
  };

  const firstResult = await stub.publish(
    entry.keyHash,
    first.revision,
    { ...candidate, objectKey: first.objectKey, freshUntil: 5_000, swrUntil: 8_000 },
    undefined,
    first.objectKey,
    source,
  );
  const secondResult = await stub.publish(
    entry.keyHash,
    second.revision,
    { ...candidate, objectKey: second.objectKey, freshUntil: 6_000, swrUntil: 9_000 },
    undefined,
    second.objectKey,
    source,
  );
  assert.equal(firstResult.published, true);
  assert.equal(secondResult.published, false);

  const [restored] = await metadata();
  assert.equal(restored.activeRevision, entry.activeRevision);
  assert.equal(restored.freshUntil, 5_000);
  assert.equal(restored.swrUntil, 8_000);
  assert.equal(await metadataRowCount("pending_objects"), 0);
});

test("a re-stored entry cannot be claimed before its R2 rewrite lands", async () => {
  await put("/restore-claim", "seed", {
    cacheControl: "public, max-age=0, stale-while-revalidate=60",
  });
  const [entry] = await metadata();
  const stub = await metadataStub();
  const prefix = "runtime-cache/poc-v2/restore-claim";
  const restore = await stub.reserveWrite(entry.keyHash, entry.cacheKey, prefix, Date.now());
  const retryUntil = entry.freshUntil + 5_000;
  assert.equal(
    (
      await stub.publish(
        entry.keyHash,
        restore.revision,
        {
          statusText: entry.statusText,
          responseHeaders: entry.responseHeaders,
          revalidator: entry.revalidator,
          cacheTags: [],
          fenceTags: [],
          objectKey: restore.objectKey,
          freshUntil: retryUntil,
          swrUntil: retryUntil + 60_000,
        },
        undefined,
        restore.objectKey,
        entry,
      )
    ).published,
    true,
  );

  // R2 still holds the stale source, so a reader claims the unchanged
  // revision. The metadata's retry window refuses it until it ends.
  const claim = (now: number) =>
    stub.claimRevalidation(entry.keyHash, entry.activeRevision, entry.cacheKey, prefix, now, 100);
  assert.equal(await claim(entry.freshUntil + 1), null);
  assert.equal(await claim(retryUntil - 1), null);
  assert.equal(await metadataRowCount("revalidation_claims"), 0);
  assert.ok(await claim(retryUntil));
});

test("a stale read during a held background re-store write does not regenerate", async () => {
  await restartWithHeldSecondR2Write("before");
  await put("/restore-held-claim", "stale-body", {
    cacheControl: "public, max-age=0, stale-while-revalidate=60",
    revalidator: { fail: true },
  });

  // The first stale read's regeneration fails, and its re-store publishes
  // while the R2 rewrite is held.
  const first = await read("/restore-held-claim");
  assert.equal(first.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  await first.arrayBuffer();
  let restored = false;
  for (let attempt = 0; attempt < 100 && !restored; attempt++) {
    const [entry] = await metadata();
    restored = entry.freshUntil > Date.now() && (await metadataRowCount("pending_objects")) === 0;
    if (!restored) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(restored, "the re-store was not published");

  const second = await read("/restore-held-claim");
  assert.equal(second.headers.get("X-Workers-Response-Store"), "BLOB-STALE");
  assert.equal(await second.text(), "stale-body");
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await regenerationCount(), 1);
  }
  assert.equal(await metadataRowCount("revalidation_claims"), 0);
});

test("concurrent failed foreground regenerations leave R2 and the metadata in step", async () => {
  await put("/restore-race-foreground", "still-active", {
    cacheControl: "public, max-age=1",
    age: 1,
    revalidator: { fail: true, delayMs: 100 },
  });

  const reads = await Promise.all([
    read("/restore-race-foreground"),
    read("/restore-race-foreground"),
  ]);
  for (const response of reads) {
    assert.equal(response.status, 500);
    await response.arrayBuffer();
  }
  await waitForNoPendingObjects();

  const [entry] = await metadata();
  const object = await (
    await mf.getR2Bucket("CACHE_BODIES", "user-worker")
  ).head(`${r2Root}/${entry.keyHash}/active`);
  assert.equal(object?.customMetadata?.freshUntil, String(entry.freshUntil));
  assert.equal(object?.customMetadata?.swrUntil, String(entry.swrUntil));
});

// A failed foreground regeneration and a failed manual refresh re-store
// successive states of the same revision: the refresh reads R2 while the first
// re-store's rewrite is held, and the held rewrite then lands before or after
// the refresh's. Reads inside the retry window no longer regenerate, but a
// manual refresh still does.
async function restoreSuccessiveStates(order: "before" | "after") {
  await restartWithHeldSecondR2Write(order);
  const cacheKey = `/restore-race-${order}`;
  await put(cacheKey, "still-active", {
    cacheControl: "public, max-age=1",
    age: 1,
    revalidator: { fail: true },
  });

  const first = read(cacheKey);
  let firstRestore: any;
  for (let attempt = 0; attempt < 100 && !firstRestore; attempt++) {
    const [entry] = await metadata();
    if (entry.freshUntil > Date.now()) firstRestore = entry;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(firstRestore, "the first re-store was not published");

  const refresh = await refreshSelectors({ pathPrefixes: [cacheKey] });
  assert.equal(refresh.response.status, 500);
  const firstResponse = await first;
  assert.equal(firstResponse.status, 500);
  await firstResponse.arrayBuffer();
  await waitForNoPendingObjects();

  const [entry] = await metadata();
  assert.equal(entry.activeRevision, firstRestore.activeRevision);
  assert.notEqual(entry.freshUntil, firstRestore.freshUntil);
  const object = await (
    await mf.getR2Bucket("CACHE_BODIES", "user-worker")
  ).head(`${r2Root}/${entry.keyHash}/active`);
  assert.equal(object?.customMetadata?.freshUntil, String(entry.freshUntil));
  assert.equal(object?.customMetadata?.swrUntil, String(entry.swrUntil));

  const stored = await read(cacheKey);
  assert.equal(stored.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");
  assert.equal(await stored.text(), "still-active");
}

test("a re-store that loses to an earlier state's rewrite replaces it", async () => {
  await restoreSuccessiveStates("before");
});

// Both rewrites carry the same body, so this relies on each re-store storing
// unique bytes: R2 ETags hash the bytes, and the held write would otherwise
// still match the source ETag it compares.
test("an earlier state's re-store cannot overwrite a later one", async () => {
  await restoreSuccessiveStates("after");
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
    assert.deepEqual(
      await storage.exec(
        `SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name IN (
          'pending_r2_tombstones_r2_pending',
          'pending_r2_tombstones_edge_pending',
          'pending_r2_tombstones_r2_sequence',
          'pending_r2_tombstones_edge_sequence'
        ) ORDER BY name`,
      ),
      [
        { name: "pending_r2_tombstones_edge_pending" },
        { name: "pending_r2_tombstones_edge_sequence" },
        { name: "pending_r2_tombstones_r2_pending" },
        { name: "pending_r2_tombstones_r2_sequence" },
      ],
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

test("tombstone cleanup uses persistent queue indexes and keyed completion", async () => {
  await put("/tombstone-query-plan", "active");
  const storage = await mf.unsafeGetDurableObjectStorage("user-worker", "CacheMetadata", {
    name: metadataName,
  });

  const unfinished = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
    FROM pending_r2_tombstones
    WHERE r2_complete = 0
    ORDER BY key_hash LIMIT 400
  `);
  const pendingEdge = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
    FROM pending_r2_tombstones
    WHERE r2_complete = 1 AND edge_purge_complete = 0
    ORDER BY key_hash LIMIT 400
  `);
  const completed = await storage.exec(`
    EXPLAIN QUERY PLAN
    DELETE FROM pending_r2_tombstones
    WHERE r2_complete = 1 AND edge_purge_complete = 1
      AND key_hash = 'tombstone-query-plan' AND revision = 1
  `);
  const sequenceUnfinished = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
    FROM pending_r2_tombstones
    WHERE r2_complete = 0 AND tombstone_sequence = 1
    ORDER BY key_hash LIMIT 400
  `);
  const sequencePendingEdge = await storage.exec(`
    EXPLAIN QUERY PLAN
    SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
    FROM pending_r2_tombstones
    WHERE r2_complete = 1 AND edge_purge_complete = 0 AND tombstone_sequence = 1
    ORDER BY key_hash LIMIT 400
  `);
  const sequenceCompleted = await storage.exec(`
    EXPLAIN QUERY PLAN
    DELETE FROM pending_r2_tombstones
    WHERE r2_complete = 1 AND edge_purge_complete = 0 AND tombstone_sequence <= 1
  `);
  const unfinishedDetails = unfinished
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");
  const pendingEdgeDetails = pendingEdge
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");
  const completedDetails = completed
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");
  const sequenceUnfinishedDetails = sequenceUnfinished
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");
  const sequencePendingEdgeDetails = sequencePendingEdge
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");
  const sequenceCompletedDetails = sequenceCompleted
    .map(({ detail }) => detail)
    .filter((detail): detail is string => typeof detail === "string");

  assert.ok(
    unfinishedDetails.some((detail) => detail.includes("INDEX pending_r2_tombstones_r2_pending")),
    JSON.stringify(unfinished),
  );
  assert.ok(
    pendingEdgeDetails.some((detail) =>
      detail.includes("INDEX pending_r2_tombstones_edge_pending"),
    ),
    JSON.stringify(pendingEdge),
  );
  assert.ok(
    completedDetails.some((detail) => detail.includes("PRIMARY KEY (key_hash=?)")),
    JSON.stringify(completed),
  );
  assert.ok(
    sequenceUnfinishedDetails.some((detail) =>
      detail.includes("INDEX pending_r2_tombstones_r2_sequence"),
    ),
    JSON.stringify(sequenceUnfinished),
  );
  assert.ok(
    sequencePendingEdgeDetails.some((detail) =>
      detail.includes("INDEX pending_r2_tombstones_edge_sequence"),
    ),
    JSON.stringify(sequencePendingEdge),
  );
  assert.ok(
    sequenceCompletedDetails.some((detail) =>
      detail.includes("INDEX pending_r2_tombstones_edge_sequence"),
    ),
    JSON.stringify(sequenceCompleted),
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
