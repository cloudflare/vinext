import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, test } from "vitest";

const cacheWorkerScript = fileURLToPath(
  new URL("../dist/service-cache/service.js", import.meta.url),
);
const userWorkerScript = fileURLToPath(
  new URL("../dist/service-user/user-worker.js", import.meta.url),
);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";

type PutOptions = {
  cacheControl?: string;
  delayMs?: number;
  regeneratedBody?: string;
};

let mf: Miniflare;
let worker: { fetch(...args: any[]): Promise<any> };

beforeEach(async () => {
  mf = new Miniflare({
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat", "experimental"],
    unsafeEphemeralDurableObjects: true,
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: "user-worker",
        compatibilityDate: "2026-04-08",
        compatibilityFlags: ["nodejs_compat", "experimental"],
        modules: true,
        scriptPath: userWorkerScript,
        serviceBindings: {
          RESPONSE_STORE: {
            name: "cache-worker",
            entrypoint: "ResponseStoreService",
          },
          RESPONSE_STORE_ADMIN: {
            name: "cache-worker",
            entrypoint: "ResponseStoreAdmin",
          },
        },
        bindings: {
          CF_VERSION_METADATA: {
            id: VERSION_ID,
            tag: "test",
            timestamp: "2026-09-04T00:00:00Z",
          },
        },
      },
      {
        name: "cache-worker",
        compatibilityDate: "2026-04-08",
        compatibilityFlags: ["nodejs_compat", "experimental"],
        modules: true,
        scriptPath: cacheWorkerScript,
        durableObjects: {
          CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
        },
        r2Buckets: { CACHE_BODIES: "response-store-service-test" },
      },
    ],
  });
  worker = { fetch: mf.dispatchFetch.bind(mf) };
});

afterEach(async () => {
  await mf.dispose();
});

async function put(path: string, body: BodyInit, options: PutOptions = {}) {
  const response = await worker.fetch(`https://user.test/admin/put${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Response-Cache-Control": options.cacheControl ?? "public, max-age=60",
      "X-Revalidator-Args": JSON.stringify({
        body: options.regeneratedBody ?? "regenerated",
        cacheControl: "public, max-age=60",
        delayMs: options.delayMs,
      }),
    },
    body,
  });
  assert.equal(response.status, 200, await response.text());
}

function read(path: string) {
  return worker.fetch(`https://user.test/cache${path}`);
}

test("a service-bound cache Worker stores and returns responses", async () => {
  const status = await worker.fetch("https://user.test/");
  assert.equal(status.status, 200);

  await put("/stored", "stored-body");

  const response = await read("/stored");
  assert.equal(await response.text(), "stored-body");
  assert.equal(response.headers.get("X-Workers-Response-Store"), "BLOB-FRESH");

  const namespace = await mf.getDurableObjectNamespace("CACHE_METADATA", "cache-worker");
  const entries = (
    await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const metadata = namespace.getByName(`${VERSION_ID}:metadata-shard:${index}-of-4`) as any;
        return metadata.inspect() as Promise<unknown[]>;
      }),
    )
  ).flat();
  assert.equal(entries.length, 1);
});

test("the cache Worker default entrypoint does not expose service details", async () => {
  const cacheWorker = await mf.getWorker("cache-worker");
  const response = await cacheWorker.fetch("https://cache.test/");

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Use the ResponseStoreService service binding entrypoint.");
});

test("a service-bound cache Worker resolves authoritative tag expirations", async () => {
  const initial = await worker.fetch("https://user.test/admin/tag-expiration", {
    method: "POST",
    body: JSON.stringify({ tags: ["unchanged"] }),
  });
  const body = await initial.json();
  assert.equal(initial.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { expiration: 0 });
});

test("manual refresh calls back into the user Worker version", async () => {
  await put("/manual", "seed", { regeneratedBody: "manually-regenerated" });

  const refresh = await worker.fetch("https://user.test/admin/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pathPrefixes: ["/manual"] }),
  });
  assert.equal(refresh.status, 200, await refresh.text());

  const response = await read("/manual");
  assert.equal(await response.text(), "manually-regenerated");
  assert.equal(response.headers.get("X-Revalidation-Version"), VERSION_ID);
  assert.equal(response.headers.get("X-Revalidation-Reason"), "manual");
});

test("SWR keeps the passed user-Worker loopback alive after returning stale", async () => {
  await put("/swr", "stale", {
    cacheControl: "public, max-age=0, stale-while-revalidate=30",
    regeneratedBody: "fresh",
    delayMs: 100,
  });

  const stale = await read("/swr");
  assert.equal(await stale.text(), "stale");

  await new Promise((resolve) => setTimeout(resolve, 200));
  const fresh = await read("/swr");
  assert.equal(await fresh.text(), "fresh");
  assert.equal(fresh.headers.get("X-Revalidation-Reason"), "swr");
  assert.equal(fresh.headers.get("X-Revalidation-Version"), VERSION_ID);
});

test("the admin entrypoint deletes every metadata shard for a retired version", async () => {
  await put("/retired", "stored-body");

  const response = await worker.fetch("https://user.test/admin/delete-version-storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId: VERSION_ID, shards: 4 }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.versionId, VERSION_ID);
  assert.equal(result.shardCount, 4);
  assert.ok(result.deletedBytes > 0);

  for (let index = 0; index < 4; index++) {
    const storage = await mf.unsafeGetDurableObjectStorage("cache-worker", "CacheMetadata", {
      name: `${VERSION_ID}:metadata-shard:${index}-of-4`,
    });
    assert.deepEqual(
      await storage.exec("SELECT name FROM sqlite_schema WHERE name = 'entries'"),
      [],
    );
  }
});

test("the admin entrypoint rejects non-version Durable Object names", async () => {
  const response = await worker.fetch("https://user.test/admin/delete-version-storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId: "some-other-object" }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Workers Response Store requires a Worker version UUID",
  });
});
