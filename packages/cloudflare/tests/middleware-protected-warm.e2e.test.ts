import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Miniflare, type MiniflareOptions } from "miniflare";
import { afterEach, describe, test } from "vite-plus/test";

import { warmCdnCache } from "../src/cdn-warm.js";

// Issue #4702: a warm plan includes routes that middleware or proxy may
// answer itself. Their response is never cacheable, so warming should report
// it as a skip rather than failing the deploy.
const root = path.resolve(import.meta.dirname, "../../..");
const demo = path.join(root, "examples/response-store-demo");
const serviceBindingOutput = path.join(demo, "dist/server");
const selfContainedOutput = path.join(demo, ".vinext/response-store-self-contained/server");
const proxyOutput = path.join(demo, ".vinext/response-store-proxy/server");
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

async function selfContainedWorker(output: string): Promise<Miniflare> {
  return new Miniflare({
    unsafeEphemeralDurableObjects: true,
    workers: [
      {
        ...compatibility,
        bindings: versionMetadata(),
        durableObjects: { CACHE_METADATA: { className: "CacheMetadata", useSQLite: true } },
        modules: await modules(output, "index.js"),
        name: "app",
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

async function warmDashboard(worker: Miniflare) {
  // Deploy validates the build identity the Response Store stamps on page
  // responses; read it from a page middleware and proxy don't match.
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
    paths: ["/dashboard"],
    rscPaths: ["/dashboard"],
    statusSource: "vinext",
    expectedBuildId,
    expectedRscBuildId,
    retries: 0,
    fetchImpl,
  });
}

async function assertSkipped(worker: Miniflare, gate: "middleware" | "proxy") {
  const result = await warmDashboard(worker);
  assert.deepEqual(
    { failed: result.failed, failures: result.failures, skipped: result.skipped },
    { failed: 0, failures: [], skipped: 2 },
  );
  // The redirect itself is labelled BYPASS.
  const redirect = await worker.dispatchFetch("https://app.test/dashboard", {
    redirect: "manual",
  });
  await redirect.arrayBuffer();
  assert.equal(redirect.status, 307);
  // Each gate redirects to its own target, so this proves which one ran.
  assert.equal(
    new URL(redirect.headers.get("location")!, "https://app.test").search,
    `?gate=${gate}`,
  );
  assert.equal(redirect.headers.get("x-vinext-cache"), "BYPASS");
  // A request middleware or proxy lets through still reaches the Response Store.
  const page = await worker.dispatchFetch("https://app.test/dashboard", {
    headers: { Cookie: "session=1" },
    redirect: "manual",
  });
  await page.arrayBuffer();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-vinext-cache"), "MISS");
}

describe("warming a route that middleware or proxy answers itself (#4702)", () => {
  test("middleware, Response Store service-binding mode", async () => {
    miniflare = await serviceBindingWorker();
    await assertSkipped(miniflare, "middleware");
  });

  test("middleware, Response Store self-contained mode", async () => {
    miniflare = await selfContainedWorker(selfContainedOutput);
    await assertSkipped(miniflare, "middleware");
  });

  test("proxy, Response Store self-contained mode", async () => {
    miniflare = await selfContainedWorker(proxyOutput);
    await assertSkipped(miniflare, "proxy");
  });
});
