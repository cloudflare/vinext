import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, test } from "vitest";

const cacheWorkerScript = fileURLToPath(
  new URL("../dist/service-cache/cache-worker.js", import.meta.url),
);
const userWorkerScript = fileURLToPath(
  new URL("../dist/service-user/user-worker.js", import.meta.url),
);

let mf;
let worker;

beforeEach(async () => {
  mf = new Miniflare({
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat", "experimental"],
    unsafeEphemeralDurableObjects: true,
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
        },
        bindings: {
          CF_VERSION_METADATA: {
            id: "user-worker-v1",
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

async function put(path, body, options = {}) {
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

function read(path) {
  return worker.fetch(`https://user.test/cache${path}`);
}

test("a service-bound cache Worker stores and returns responses", async () => {
  const status = await worker.fetch("https://user.test/");
  assert.equal(status.status, 200);

  await put("/stored", "stored-body");

  const response = await read("/stored");
  assert.equal(await response.text(), "stored-body");
  assert.equal(response.headers.get("X-Workers-Response-Store"), "R2-FRESH");
});

test("a service-bound cache Worker resolves tag expirations through its cache entrypoint", async () => {
  const before = Date.now();
  const initial = await worker.fetch("https://user.test/admin/tag-expiration", {
    method: "POST",
    body: JSON.stringify({ tags: ["unchanged"], newerThan: before }),
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
  assert.equal(response.headers.get("X-Revalidation-Version"), "user-worker-v1");
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
  assert.equal(fresh.headers.get("X-Revalidation-Version"), "user-worker-v1");
});
