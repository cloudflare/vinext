import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, test } from "vitest";

const workerScript = fileURLToPath(new URL("../dist/worker/worker.js", import.meta.url));
const metadataName = "poc-v2";

let mf;
let worker;

beforeEach(async () => {
  mf = new Miniflare({
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat"],
    unsafeEphemeralDurableObjects: true,
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
  await mf.dispose();
});

async function put(path, body, options = {}) {
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
  if (options.bodyDelayMs) headers.set("X-Body-Delay-Ms", String(options.bodyDelayMs));
  const response = await worker.fetch(`https://user.test/admin/put${path}`, {
    method: "PUT",
    headers,
    body,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`put fixture returned ${response.status}: ${text}`);
  }
  return { response, json: parsed };
}

async function read(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.host) headers.set("X-Cache-Host", options.host);
  return worker.fetch(`https://user.test/cache${path}`, { headers });
}

async function refreshSelectors(options) {
  const response = await worker.fetch("https://user.test/admin/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  return { response, json: await response.json() };
}

async function purge(options) {
  const response = await worker.fetch("https://user.test/admin/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  return { response, json: await response.json() };
}

async function metadataStub() {
  const namespace = await mf.getDurableObjectNamespace("CACHE_METADATA", "user-worker");
  return namespace.getByName(metadataName);
}

async function metadata() {
  return (await metadataStub()).inspect();
}

async function r2Objects() {
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  return bucket.list();
}

test("put and fetch use pathname plus query, excluding host", async () => {
  const result = await put("/identity?a=1", "first", { host: "one.example" });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const sameKey = await read("/identity?a=1", { host: "two.example" });
  assert.equal(sameKey.status, 200);
  assert.equal(await sameKey.text(), "first");
  assert.equal(sameKey.headers.get("X-Workers-Response-Store"), "R2-FRESH");

  const differentQuery = await read("/identity?a=2", { host: "one.example" });
  assert.equal(differentQuery.status, 404);

  const entries = await metadata();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cacheKey, "/identity?a=1");
  assert.equal("body" in entries[0], false);
  assert.equal("legacyResponseMetadata" in entries[0], false);
  const objects = await r2Objects();
  assert.equal(objects.objects.length, 1);
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const object = await bucket.head(objects.objects[0].key);
  assert.deepEqual(Object.keys(object.customMetadata).sort(), [
    "createdAt",
    "initialAge",
    "status",
  ]);
  assert.equal(object.customMetadata.status, "200");
  assert.equal(object.customMetadata.initialAge, "0");
  assert.match(object.customMetadata.createdAt, /^\d{13}$/);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(object.customMetadata)).byteLength < 128,
    "R2 custom metadata should remain tiny relative to the 8 KiB object metadata limit",
  );
});

test("null-body response statuses refill without an R2 body stream", async () => {
  const result = await put("/no-content", "ignored", { status: 204 });
  assert.deepEqual(result.json, { backingStoreUpdated: true, edgePurgeAccepted: true });

  const response = await read("/no-content");
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal((await r2Objects()).objects.length, 1);
});

test("metadata remains readable when published by the pre-R2-metadata binding", async () => {
  const cacheKey = "/legacy-object-metadata";
  const keyHash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheKey))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const objectKey = "runtime-cache/legacy-object-metadata";
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  await bucket.put(objectKey, "legacy-body");
  const stub = await metadataStub();
  const revision = await stub.beginWrite(keyHash, cacheKey);
  await stub.publish(keyHash, revision, {
    objectKey,
    status: 200,
    statusText: "",
    responseHeaders: [["content-type", "text/plain"]],
    createdAt: Date.now(),
    initialAge: 0,
    freshUntil: Date.now() + 60_000,
    swrUntil: Date.now() + 60_000,
    revalidator: null,
    cacheTags: [],
  });

  const response = await read(cacheKey);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "legacy-body");
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
  assert.match(ageBasis, /^\d{13}:1$/);
  await first.arrayBuffer();

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const later = await read("/freshness");
  assert.match(
    later.headers.get("Cloudflare-CDN-Cache-Control"),
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
  assert.equal(immediatelyStale.headers.get("X-Workers-Response-Store"), "R2-STALE");
  assert.equal(
    immediatelyStale.headers.get("Cloudflare-CDN-Cache-Control"),
    "max-age=0, stale-while-revalidate=30",
  );

  await put("/policy/invalid-max-age", "policy", {
    cacheControl: "public, max-age=2.5, stale-while-revalidate=30",
    noRevalidator: true,
  });
  const invalidMaxAge = await read("/policy/invalid-max-age");
  assert.equal(invalidMaxAge.headers.get("X-Workers-Response-Store"), "R2-STALE");
  assert.match(
    invalidMaxAge.headers.get("Cloudflare-CDN-Cache-Control"),
    /^max-age=0, stale-while-revalidate=(29|30)$/,
  );

  await put("/policy/invalid-swr", "policy", {
    cacheControl: "public, max-age=60, stale-while-revalidate=30seconds",
  });
  const invalidSwr = await read("/policy/invalid-swr");
  assert.match(
    invalidSwr.headers.get("Cloudflare-CDN-Cache-Control"),
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
  assert.equal(responses[0].headers.get("X-Workers-Response-Store"), "R2-STALE");
  assert.match(
    responses[0].headers.get("Cloudflare-CDN-Cache-Control"),
    /^max-age=0, stale-while-revalidate=(29|30)$/,
  );

  await new Promise((resolve) => setTimeout(resolve, 650));
  const fresh = await read("/stale");
  assert.equal(await fresh.text(), "swr-regenerated");
  assert.equal(fresh.headers.get("X-Revalidation-Reason"), "swr");
  assert.equal(fresh.headers.get("X-Workers-Response-Store-Revision"), "2");
  const stats = await (await worker.fetch("https://user.test/admin/stats")).json();
  assert.equal(stats.regenerationCount, 1);
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
  const stats = await (await worker.fetch("https://user.test/admin/stats")).json();
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

test("missing active R2 content regenerates through the named user entrypoint", async () => {
  await put("/missing-body", "lost", {
    revalidator: { body: "recovered", cacheControl: "public, max-age=60" },
  });
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const before = await bucket.list();
  await bucket.delete(before.objects[0].key);

  const response = await read("/missing-body");
  assert.equal(await response.text(), "recovered");
  assert.equal(response.headers.get("X-Revalidation-Reason"), "missing");
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
    tags: [tags.at(-1)],
    revalidator: { body: "refreshed", cacheControl: "public, max-age=60" },
  });

  assert.deepEqual((await refreshSelectors({ tags })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.equal(await (await read("/refresh-many-tags")).text(), "refreshed");
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
  assert.deepEqual((await refreshSelectors({ tags: ["ORIGINAL"] })).json, {
    backingStoreUpdated: true,
    edgePurgeAccepted: false,
  });
  assert.deepEqual((await metadata())[0].cacheTags, ["Replacement"]);
  assert.deepEqual((await refreshSelectors({ tags: ["original"] })).json, {
    backingStoreUpdated: false,
    edgePurgeAccepted: false,
  });

  await purge({ tags: ["REPLACEMENT"] });
  assert.equal((await read("/tag-index")).status, 404);
  assert.ok((await (await metadataStub()).getTagExpiration(["replacement"])) > 0);
});

test("tag expiration is recorded without creating an R2 marker object", async () => {
  const before = Date.now();
  await purge({ tags: ["missing-tag"] });

  const stub = await metadataStub();
  assert.ok((await stub.getTagExpiration(["missing-tag"])) >= before);
  assert.equal(await stub.getTagExpiration(["other-tag"]), 0);

  const batchedTags = Array.from({ length: 101 }, (_, index) => `tag-${index}`);
  await purge({ tags: [batchedTags.at(-1)] });
  assert.ok((await stub.getTagExpiration(batchedTags)) >= before);
  assert.equal((await r2Objects()).objects.length, 0);
});

test("the internal purge tag is first and large tag sets remain selectable", async () => {
  await put("/cache-tag-order", "tagged", { tags: ["user-tag"] });
  const taggedResponse = await read("/cache-tag-order");
  const cacheTag = taggedResponse.headers.get("Cache-Tag");
  assert.ok(cacheTag.startsWith("runtime-cache-"));
  await taggedResponse.arrayBuffer();

  const tags = Array.from(
    { length: 1_000 },
    (_, index) => `cache-tag-${String(index).padStart(4, "0")}-abcdefgh`,
  );
  await put("/many-cache-tags", "tagged", { tags });

  await purge({ tags: [tags.at(-1)] });
  assert.equal((await read("/many-cache-tags")).status, 404);
  assert.equal(await (await read("/cache-tag-order")).text(), "tagged");
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
  assert.equal((await r2Objects()).objects.length, 0);
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

test("retention sweep removes orphaned candidates without deleting active R2 objects", async () => {
  await put("/active-cleanup", "active");
  const bucket = await mf.getR2Bucket("CACHE_BODIES", "user-worker");
  const stub = await metadataStub();
  const activeObjectKey = (await metadata())[0].objectKey;
  const orphanObjectKey = "runtime-cache/orphaned-candidate";
  await bucket.put(orphanObjectKey, "orphan");
  await stub.trackPendingObject(activeObjectKey, 0);
  await stub.trackPendingObjects([orphanObjectKey], 0);

  assert.equal(await stub.sweepExpiredPendingObjects(1), 1);

  assert.equal(await bucket.head(orphanObjectKey), null);
  assert.notEqual(await bucket.head(activeObjectKey), null);
  await stub.finishPendingObjects([activeObjectKey]);

  const finishedKeys = Array.from({ length: 101 }, (_, index) => `finished-${index}`);
  await stub.trackPendingObjects(finishedKeys, 0);
  await stub.finishPendingObjects(finishedKeys);
  assert.deepEqual(await stub.listExpiredPendingObjects(1, finishedKeys.length), []);
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
  assert.equal((await r2Objects()).objects.length, 0);
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
