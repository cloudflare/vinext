import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Miniflare, type MiniflareOptions } from "miniflare";
import { afterEach, beforeEach, describe, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const appOutput = path.join(root, "examples/workers-cache/dist/server");
const cacheOutput = path.join(root, "packages/workers-response-store/dist/service-cache");

let miniflare: Miniflare;
let workerVersionId: string;

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

async function request(pathname: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) {
  return miniflare.dispatchFetch(`https://app.test${pathname}`, init);
}

function htmlValue(html: string, testId: string): string {
  const value = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]+)`))?.[1];
  assert.ok(value, `missing ${testId} in response`);
  return value;
}

async function cacheStatus(pathname: string): Promise<{ body: string; status: string | null }> {
  const response = await request(pathname);
  assert.equal(response.status, 200);
  return { body: await response.text(), status: response.headers.get("x-vinext-cache") };
}

beforeEach(async () => {
  workerVersionId = crypto.randomUUID();
  const compatibility = {
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat", "experimental"],
  };
  miniflare = new Miniflare({
    unsafeEphemeralDurableObjects: true,
    workers: [
      {
        ...compatibility,
        bindings: {
          CF_VERSION_METADATA: {
            id: workerVersionId,
            tag: "test",
            timestamp: new Date().toISOString(),
          },
        },
        modules: await modules(appOutput, "index.js"),
        name: "app",
        serviceBindings: {
          ASSETS: async () => new Response(null, { status: 404 }),
          RESPONSE_STORE: { entrypoint: "ResponseStoreService", name: "cache" },
        },
      },
      {
        ...compatibility,
        durableObjects: {
          CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
        },
        modules: await modules(cacheOutput, "cache-worker.js"),
        name: "cache",
        r2Buckets: { CACHE_BODIES: crypto.randomUUID() },
      },
    ],
  } satisfies MiniflareOptions);
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("Cloudflare Workers Response Store adapter", () => {
  test("the application build owns no cache storage", async () => {
    const config = JSON.parse(
      await readFile(path.join(appOutput, "wrangler.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(config.exports, {});
    assert.deepEqual(config.kv_namespaces, []);
    assert.deepEqual(config.r2_buckets, []);
    assert.deepEqual(config.durable_objects, { bindings: [] });
    assert.equal(config.cache, undefined);
    assert.deepEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" });
  });

  test("validates staged-version warmup requests and exposes build identity", async () => {
    const override = 'app="staged"';
    const wrongVersion = await request("/cached/warmup", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": override,
        "X-Vinext-Expected-Worker-Version": "wrong-version",
      },
    });
    assert.equal(wrongVersion.status, 503);

    const staged = await request("/cached/warmup", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": override,
        "X-Vinext-Expected-Worker-Version": workerVersionId,
      },
    });
    assert.equal(staged.status, 200);
    assert.notEqual(staged.headers.get("x-vinext-build-id"), null);
  });

  test("caches App pages, App routes, Pages routes, and canonical RSC", async () => {
    const firstPageResponse = await request("/cached/local", {
      headers: { "x-request-id": "first" },
    });
    const firstPage = {
      body: await firstPageResponse.text(),
      status: firstPageResponse.headers.get("x-vinext-cache"),
    };
    const secondPageResponse = await request("/cached/local", {
      headers: { "x-request-id": "second" },
    });
    const secondPage = {
      body: await secondPageResponse.text(),
      status: secondPageResponse.headers.get("x-vinext-cache"),
    };
    assert.equal(firstPage.status, "MISS");
    assert.equal(secondPage.status, "HIT");
    assert.equal(secondPage.body, firstPage.body);
    assert.notEqual(secondPageResponse.headers.get("age"), null);
    for (const name of [
      "cf-cache-status",
      "x-workers-response-store",
      "x-workers-response-store-age-basis",
      "x-workers-response-store-binding-invocation",
      "x-workers-response-store-revision",
    ]) {
      assert.equal(secondPageResponse.headers.get(name), null);
    }

    for (const pathname of ["/api/now", "/pages-prewarm"]) {
      const first = await cacheStatus(pathname);
      const second = await cacheStatus(pathname);
      assert.equal(first.status, "MISS");
      assert.equal(second.status, "HIT");
      assert.equal(second.body, first.body);
    }

    const init = { headers: { Accept: "text/x-component", RSC: "1" } };
    const firstRsc = await request("/cached/rsc.rsc?_rsc=", init);
    const firstBody = await firstRsc.text();
    const secondRsc = await request("/cached/rsc.rsc?_rsc=", init);
    assert.equal(firstRsc.headers.get("x-vinext-cache"), "MISS");
    assert.equal(secondRsc.headers.get("x-vinext-cache"), "HIT");
    assert.equal(await secondRsc.text(), firstBody);
  });

  test("seeds canonical RSC from one HTML warmup request", async () => {
    const pathname = "/cached/intro";
    const html = await request(pathname, {
      headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
    });
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("x-vinext-cache"), "MISS");
    await html.arrayBuffer();

    const browserHtml = await request(pathname, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assert.equal(browserHtml.headers.get("x-vinext-cache"), "HIT");
    await browserHtml.body?.cancel();

    const rsc = await request(`${pathname}?_rsc`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    assert.equal(rsc.status, 200);
    assert.equal(rsc.headers.get("x-vinext-cache"), "HIT");
    assert.match(rsc.headers.get("content-type") ?? "", /^text\/x-component/);
    assert.ok((await rsc.arrayBuffer()).byteLength > 0);

    const retryPath = `${pathname}?retry=1`;
    const storedHtml = await request(retryPath);
    assert.equal(storedHtml.headers.get("x-vinext-cache"), "MISS");
    await storedHtml.arrayBuffer();

    const retriedWarmup = await request(retryPath, {
      headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
    });
    assert.equal(retriedWarmup.headers.get("x-vinext-cache"), "MISS");
    await retriedWarmup.arrayBuffer();

    const repairedRsc = await request(`${retryPath}&_rsc`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    assert.equal(repairedRsc.headers.get("x-vinext-cache"), "HIT");
    await repairedRsc.body?.cancel();
  });

  test("publishes non-App-page warmups before returning", async () => {
    for (const pathname of ["/api/now", "/pages-prewarm"]) {
      const key = `${pathname}?warmup=${crypto.randomUUID()}`;
      const warmed = await request(key, {
        headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
      });
      assert.equal(warmed.headers.get("x-vinext-cache"), "MISS");
      await warmed.arrayBuffer();

      const stored = await request(key);
      assert.equal(stored.headers.get("x-vinext-cache"), "HIT");
      await stored.body?.cancel();
    }
  });

  test("caches HEAD independently without storing a body", async () => {
    const first = await request("/pages-prewarm?head=1", { method: "HEAD" });
    const second = await request("/pages-prewarm?head=1", { method: "HEAD" });
    assert.equal(first.headers.get("x-vinext-cache"), "MISS");
    assert.equal(second.headers.get("x-vinext-cache"), "HIT");
    assert.equal(await first.text(), "");
    assert.equal(await second.text(), "");
  });

  test("returns cold App pages before their bodies complete and publishes them", async () => {
    const namespace = await miniflare.getDurableObjectNamespace("CACHE_METADATA", "cache");
    const metadata = namespace.getByName(workerVersionId);
    const inspect = Reflect.get(metadata, "inspect");
    assert.equal(typeof inspect, "function");
    const previousEntries = (await Reflect.apply(inspect, metadata, [])) as unknown[];
    const key = `/streaming-cache?key=${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const first = await request(key);
    assert.equal(first.headers.get("x-vinext-cache"), "MISS");
    const responseElapsed = Date.now() - startedAt;
    assert.ok(responseElapsed < 800, `App page response took ${responseElapsed}ms`);
    const body = await first.text();
    const totalElapsed = Date.now() - startedAt;
    assert.ok(
      totalElapsed - responseElapsed > 500,
      `App page body completed only ${totalElapsed - responseElapsed}ms after its response`,
    );
    assert.match(body, /streaming-shell/);
    assert.match(body, /streaming-complete/);

    let published = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const entries = (await Reflect.apply(inspect, metadata, [])) as unknown[];
      if (entries.length > previousEntries.length) {
        published = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(published, "completed response was not published");
    const second = await request(key);
    assert.equal(second.headers.get("x-vinext-cache"), "HIT");
    assert.equal(await second.text(), body);
  });

  test("does not persist credentials or fragment a public entry by them", async () => {
    const first = await request("/cached/credentials", {
      headers: { authorization: "Bearer first-secret", cookie: "session=first-secret" },
    });
    const second = await request("/cached/credentials", {
      headers: { authorization: "Bearer second-secret", cookie: "session=second-secret" },
    });
    assert.equal(first.headers.get("x-vinext-cache"), "MISS");
    assert.equal(second.headers.get("x-vinext-cache"), "HIT");
    assert.equal(await second.text(), await first.text());

    const namespace = await miniflare.getDurableObjectNamespace("CACHE_METADATA", "cache");
    const metadata = namespace.getByName(workerVersionId);
    const inspect = Reflect.get(metadata, "inspect");
    assert.equal(typeof inspect, "function");
    const serialized = JSON.stringify(await Reflect.apply(inspect, metadata, []));
    assert.doesNotMatch(serialized, /first-secret|second-secret/);
  });

  test("keeps concurrent cold renders successful when a cache write loses CAS", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request("/cached/concurrent")),
    );
    assert.ok(responses.every((response) => response.status === 200));
    await Promise.all(responses.map((response) => response.arrayBuffer()));
  });

  test("keeps dynamic and unsupported Vary responses out of shared storage", async () => {
    const firstDynamic = await cacheStatus("/dynamic");
    const secondDynamic = await cacheStatus("/dynamic");
    assert.equal(firstDynamic.status, "MISS");
    assert.equal(secondDynamic.status, "MISS");
    assert.notEqual(firstDynamic.body, secondDynamic.body);

    const firstVary = await cacheStatus("/vary");
    const secondVary = await cacheStatus("/vary");
    assert.equal(firstVary.status, "BYPASS");
    assert.equal(secondVary.status, "BYPASS");
  });

  test("serves stale route and use-cache values while loopback regenerates them", async () => {
    const firstRoute = await cacheStatus("/api/now");
    const firstRouteId = JSON.parse(firstRoute.body).renderId as string;
    const firstPage = await cacheStatus("/use-cache");
    const firstData = htmlValue(firstPage.body, "use-cache-value");
    const firstPageRenders = Number(htmlValue(firstPage.body, "use-cache-route-renders"));

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const staleRoute = await cacheStatus("/api/now");
    const stalePage = await cacheStatus("/use-cache");
    const staleData = htmlValue(stalePage.body, "use-cache-value");
    const stalePageRenders = Number(htmlValue(stalePage.body, "use-cache-route-renders"));
    assert.equal(JSON.parse(staleRoute.body).renderId, firstRouteId);
    assert.equal(staleData, firstData);
    assert.equal(stalePageRenders, firstPageRenders + 1);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const freshRoute = await cacheStatus("/api/now");
    const freshPage = await cacheStatus("/use-cache");
    const freshData = htmlValue(freshPage.body, "use-cache-value");
    const freshPageRenders = Number(htmlValue(freshPage.body, "use-cache-route-renders"));
    assert.notEqual(JSON.parse(freshRoute.body).renderId, firstRouteId);
    assert.notEqual(freshData, firstData);
    assert.match(freshData, /^value:/);
    assert.equal(freshPageRenders, stalePageRenders + 1);
  });

  test("keeps the active response when background regeneration becomes non-cacheable", async () => {
    const pathname = `/api/revalidation-policy?key=${crypto.randomUUID()}`;
    const seeded = await request(pathname, { headers: { "x-cacheability-seed": "1" } });
    const seededBody = await seeded.text();
    assert.equal(seeded.headers.get("x-vinext-cache"), "MISS");

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const stale = await request(pathname);
    assert.equal(await stale.text(), seededBody);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const bucket = await miniflare.getR2Bucket("CACHE_BODIES", "cache");
    const objects = await bucket.list();
    assert.equal(objects.objects.length, 1);
    assert.match(objects.objects[0].key, /\/1$/);
  });

  test("never serves a hard-expired use-cache value", async () => {
    const first = htmlValue((await cacheStatus("/use-cache-expired")).body, "expired-cache-value");

    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const regenerated = htmlValue(
      (await cacheStatus("/use-cache-expired")).body,
      "expired-cache-value",
    );
    assert.notEqual(regenerated, first);
  });

  test("revalidatePath invalidates soft-tagged use-cache data", async () => {
    // Mirrors the implicit-tag behavior covered by Next.js in:
    // test/e2e/app-dir/use-cache-swr/use-cache-swr.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-swr/use-cache-swr.test.ts
    const first = htmlValue((await cacheStatus("/use-cache")).body, "use-cache-value");
    const purge = await request("/api/revalidate-path", {
      body: JSON.stringify({ path: "/use-cache" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(purge.status, 200, await purge.text());

    const regenerated = htmlValue((await cacheStatus("/use-cache")).body, "use-cache-value");
    assert.notEqual(regenerated, first);
  });

  test("revalidates tags and purges paths through the unified store", async () => {
    const firstTagged = await cacheStatus("/cached/tagged");
    const firstId = htmlValue(firstTagged.body, "rendered-at");
    const revalidate = await request("/api/revalidate-tag", {
      body: JSON.stringify({ tag: "post:tagged" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(revalidate.status, 200, await revalidate.text());
    const refreshed = await cacheStatus("/cached/tagged");
    assert.notEqual(htmlValue(refreshed.body, "rendered-at"), firstId);

    const firstPurged = await cacheStatus("/cached/purged");
    const purge = await request("/api/revalidate-path", {
      body: JSON.stringify({ path: "/cached/purged" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(purge.status, 200, await purge.text());
    const afterPurge = await cacheStatus("/cached/purged");
    assert.equal(afterPurge.status, "MISS");
    assert.notEqual(afterPurge.body, firstPurged.body);
  });
});
