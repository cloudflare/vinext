import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Miniflare, type MiniflareOptions } from "miniflare";
import { afterEach, describe, test } from "vite-plus/test";

import { warmCdnCache } from "../src/cdn-warm.js";

// Issue #4705: a warm plan includes paths that a next.config redirect or an
// external rewrite answers in the request stage. Their response is never
// cacheable, so warming should report it as a skip rather than failing.
const root = path.resolve(import.meta.dirname, "../../..");
const demo = path.join(root, "examples/response-store-demo");
const serviceBindingOutput = path.join(demo, "dist/server");
const selfContainedOutput = path.join(demo, ".vinext/response-store-self-contained/server");
const cacheOutput = path.join(root, "packages/workers-response-store/dist");

let miniflare: Miniflare | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

async function modules(directory: string, entry: string) {
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith(".js"),
  );
  return Promise.all(
    [entry, ...files.filter((file) => file !== entry)].map(async (file) => ({
      contents: await readFile(path.join(directory, file), "utf8"),
      path: file,
      type: "ESModule" as const,
    })),
  );
}

const compatibility = {
  compatibilityDate: "2026-04-08",
  compatibilityFlags: ["nodejs_compat", "experimental"],
};

function versionMetadata() {
  return {
    CF_VERSION_METADATA: {
      id: crypto.randomUUID(),
      tag: "test",
      timestamp: new Date().toISOString(),
    },
  };
}

// The external rewrite's upstream.
const outboundService = async () =>
  new Response("upstream docs", {
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=60" },
  });

async function selfContainedWorker(): Promise<Miniflare> {
  return new Miniflare({
    unsafeEphemeralDurableObjects: true,
    workers: [
      {
        ...compatibility,
        bindings: versionMetadata(),
        durableObjects: { CACHE_METADATA: { className: "CacheMetadata", useSQLite: true } },
        modules: await modules(selfContainedOutput, "index.js"),
        name: "app",
        outboundService,
        r2Buckets: { CACHE_BODIES: crypto.randomUUID() },
        serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) },
      },
    ],
  } satisfies MiniflareOptions);
}

async function serviceBindingWorker(): Promise<Miniflare> {
  return new Miniflare({
    unsafeEphemeralDurableObjects: true,
    workers: [
      {
        ...compatibility,
        bindings: versionMetadata(),
        modules: await modules(serviceBindingOutput, "index.js"),
        name: "app",
        outboundService,
        serviceBindings: {
          ASSETS: async () => new Response(null, { status: 404 }),
          RESPONSE_STORE: { entrypoint: "ResponseStoreService", name: "cache" },
        },
      },
      {
        ...compatibility,
        durableObjects: { CACHE_METADATA: { className: "CacheMetadata", useSQLite: true } },
        modules: await modules(cacheOutput, "service.js"),
        name: "cache",
        r2Buckets: { CACHE_BODIES: crypto.randomUUID() },
      },
    ],
  } satisfies MiniflareOptions);
}

async function warm(worker: Miniflare, pathname: string) {
  const page = await worker.dispatchFetch("https://app.test/", { redirect: "manual" });
  await page.arrayBuffer();
  const expectedBuildId = page.headers.get("x-vinext-build-id") ?? undefined;
  const rsc = await worker.dispatchFetch("https://app.test/?_rsc", {
    headers: { RSC: "1" },
    redirect: "manual",
  });
  await rsc.arrayBuffer();
  const expectedRscBuildId = rsc.headers.get("x-vinext-rsc-build-id") ?? undefined;
  assert.ok(expectedBuildId && expectedRscBuildId);
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    worker.dispatchFetch(String(input instanceof Request ? input.url : input), {
      ...(init as object),
      redirect: "manual",
    })) as unknown as typeof fetch;
  return warmCdnCache({
    targetUrl: "https://app.test",
    paths: [pathname],
    rscPaths: [pathname],
    statusSource: "vinext",
    expectedBuildId,
    expectedRscBuildId,
    retries: 0,
    fetchImpl,
  });
}

async function assertSkipped(worker: Miniflare, pathname: string, status: number) {
  const response = await worker.dispatchFetch(`https://app.test${pathname}`, {
    redirect: "manual",
  });
  await response.arrayBuffer();
  // Proves the config rule, not a page, answered.
  assert.equal(response.status, status);
  const result = await warm(worker, pathname);
  assert.deepEqual(
    { failed: result.failed, failures: result.failures, skipped: result.skipped },
    { failed: 0, failures: [], skipped: 2 },
  );
  assert.equal(response.headers.get("x-vinext-cache"), "BYPASS");
}

describe("warming a path a next.config rule answers in the request stage (#4705)", () => {
  for (const [mode, create] of [
    ["service-binding", serviceBindingWorker],
    ["self-contained", selfContainedWorker],
  ] as const) {
    test(`config redirect, Response Store ${mode} mode`, async () => {
      miniflare = await create();
      await assertSkipped(miniflare, "/config-redirect", 307);
    });

    test(`config external rewrite, Response Store ${mode} mode`, async () => {
      miniflare = await create();
      await assertSkipped(miniflare, "/config-external", 200);
    });
  }
});
