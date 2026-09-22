import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Miniflare, type MiniflareOptions } from "miniflare";
import { afterEach, beforeEach, describe, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const appOutput = path.join(root, "examples/response-store-demo/dist/server");
const selfContainedAppOutput = path.join(
  root,
  "examples/response-store-demo/.vinext/response-store-self-contained/server",
);
const cacheOutput = path.join(root, "packages/workers-response-store/dist");
const cacheConfigPath = path.join(
  root,
  "examples/response-store-demo/wrangler.response-store.jsonc",
);
const responseStoreShards = 4;

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

async function metadataEntries(): Promise<unknown[][]> {
  const namespace = await miniflare.getDurableObjectNamespace("CACHE_METADATA", "cache");
  return Promise.all(
    Array.from({ length: responseStoreShards }, async (_, index) => {
      const metadata = namespace.getByName(
        `${workerVersionId}:r2-v1:metadata-shard:${index}-of-${responseStoreShards}`,
      );
      const inspect = Reflect.get(metadata, "inspect");
      assert.equal(typeof inspect, "function");
      return (await Reflect.apply(inspect, metadata, [])) as unknown[];
    }),
  );
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
        modules: await modules(cacheOutput, "service.js"),
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
  test("builds both deployment modes with their configured metadata location hints", async () => {
    const serviceBinding = (await modules(appOutput, "index.js"))
      .map(({ contents }) => contents)
      .join("\n");
    const selfContained = (await modules(selfContainedAppOutput, "index.js"))
      .map(({ contents }) => contents)
      .join("\n");

    assert.match(serviceBinding, /options:\{locationHint:[`"']wnam[`"'],shards:4\}/);
    assert.match(selfContained, /options:\{locationHint:[`"']weur[`"'],shards:4\}/);
  });

  test("does not invoke Response Store for a force-dynamic route", async () => {
    let responseStoreRequests = 0;
    const isolated = new Miniflare({
      workers: [
        {
          bindings: {
            CF_VERSION_METADATA: {
              id: crypto.randomUUID(),
              tag: "test",
              timestamp: new Date().toISOString(),
            },
          },
          compatibilityDate: "2026-04-08",
          compatibilityFlags: ["nodejs_compat", "experimental"],
          modules: await modules(appOutput, "index.js"),
          name: "app",
          serviceBindings: {
            ASSETS: async () => new Response(null, { status: 404 }),
            RESPONSE_STORE: async () => {
              responseStoreRequests++;
              return new Response("Response Store must not be invoked", { status: 500 });
            },
          },
        },
      ],
    } satisfies MiniflareOptions);

    try {
      const first = await isolated.dispatchFetch("https://app.test/force-dynamic");
      const firstBody = await first.text();
      const second = await isolated.dispatchFetch("https://app.test/force-dynamic");
      const secondBody = await second.text();

      assert.equal(first.status, 200, firstBody.slice(0, 500));
      assert.equal(second.status, 200);
      assert.equal(first.headers.get("x-vinext-cache"), "BYPASS");
      assert.equal(second.headers.get("x-vinext-cache"), "BYPASS");
      assert.notEqual(
        htmlValue(firstBody, "force-dynamic-render-id"),
        htmlValue(secondBody, "force-dynamic-render-id"),
      );
      assert.equal(responseStoreRequests, 0);
    } finally {
      await isolated.dispose();
    }
  });

  test("runs cold fills, hits, and SWR loopback in one Worker", async () => {
    const inline = new Miniflare({
      unsafeEphemeralDurableObjects: true,
      workers: [
        {
          bindings: {
            CF_VERSION_METADATA: {
              id: crypto.randomUUID(),
              tag: "test",
              timestamp: new Date().toISOString(),
            },
          },
          compatibilityDate: "2026-04-08",
          compatibilityFlags: ["nodejs_compat", "experimental"],
          durableObjects: {
            CACHE_METADATA: { className: "CacheMetadata", useSQLite: true },
          },
          modules: await modules(selfContainedAppOutput, "index.js"),
          name: "app",
          r2Buckets: { CACHE_BODIES: crypto.randomUUID() },
          serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) },
        },
      ],
    } satisfies MiniflareOptions);

    try {
      const fetch = () => inline.dispatchFetch("https://app.test/api/now");
      const first = await fetch();
      const firstBody = await first.text();
      const hit = await fetch();
      assert.equal(first.headers.get("x-vinext-cache"), "MISS");
      assert.equal(hit.headers.get("x-vinext-cache"), "HIT");
      assert.equal(await hit.text(), firstBody);

      const independent = await inline.dispatchFetch(
        "https://app.test/query-on-demand/self-contained?q=first",
      );
      const independentBody = await independent.text();
      const otherQuery = await inline.dispatchFetch(
        "https://app.test/query-on-demand/self-contained?q=second",
      );
      assert.equal(independent.headers.get("x-vinext-cache"), "MISS");
      assert.equal(otherQuery.headers.get("x-vinext-cache"), "HIT");
      assert.equal(await otherQuery.text(), independentBody);

      const dependent = await inline.dispatchFetch("https://app.test/query-dependent?q=first");
      const dependentBody = await dependent.text();
      const otherDependent = await inline.dispatchFetch(
        "https://app.test/query-dependent?q=second",
      );
      assert.notEqual(dependent.headers.get("x-vinext-cache"), "HIT");
      assert.notEqual(otherDependent.headers.get("x-vinext-cache"), "HIT");
      assert.equal(htmlValue(dependentBody, "query-dependent-value"), "first");
      assert.equal(htmlValue(await otherDependent.text(), "query-dependent-value"), "second");

      const clientEmpty = await inline.dispatchFetch("https://app.test/query-client-dependent");
      const clientEmptyBody = await clientEmpty.text();
      const clientQuery = await inline.dispatchFetch(
        "https://app.test/query-client-dependent?q=second",
      );
      assert.notEqual(clientQuery.headers.get("x-vinext-cache"), "HIT");
      assert.equal(htmlValue(clientEmptyBody, "query-client-dependent-value"), "(empty)");
      assert.equal(htmlValue(await clientQuery.text(), "query-client-dependent-value"), "second");

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const stale = await fetch();
      assert.equal(await stale.text(), firstBody);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.notEqual(await (await fetch()).text(), firstBody);
    } finally {
      await inline.dispose();
    }
  });

  test("the application and cache Worker configs own only their required bindings", async () => {
    const config = JSON.parse(
      await readFile(path.join(appOutput, "wrangler.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(config.exports, {});
    assert.deepEqual(config.kv_namespaces, []);
    assert.deepEqual(config.r2_buckets, []);
    assert.deepEqual(config.durable_objects, { bindings: [] });
    assert.deepEqual(config.cache, { enabled: false });
    assert.deepEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" });
    assert.deepEqual(config.services, [
      {
        binding: "RESPONSE_STORE",
        service: "response-store-demo-response-store",
        entrypoint: "ResponseStoreService",
      },
    ]);

    const cacheConfig = JSON.parse(
      (await readFile(cacheConfigPath, "utf8")).replace(/,\s*([}\]])/g, "$1"),
    ) as Record<string, unknown>;
    assert.deepEqual(cacheConfig.observability, { enabled: true });
    assert.deepEqual(cacheConfig.r2_buckets, [
      {
        binding: "CACHE_BODIES",
        bucket_name: "response-store-demo-response-store-cache-bodies",
      },
    ]);
    assert.deepEqual(cacheConfig.durable_objects, {
      bindings: [{ name: "CACHE_METADATA", class_name: "CacheMetadata" }],
    });
    assert.deepEqual(cacheConfig.exports, {
      default: { type: "worker", cache: { enabled: false } },
      ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
      CacheMetadata: { type: "durable-object", storage: "sqlite" },
    });
  });

  test("passes adapter sharding into the Response Store", async () => {
    await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const response = await request(`/query-on-demand/shard-${index}`);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }),
    );

    let counts: number[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      counts = (await metadataEntries()).map((entries) => entries.length);
      if (counts.reduce((total, count) => total + count, 0) >= 16) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(counts.reduce((total, count) => total + count, 0) >= 16);
    assert.ok(counts.filter(Boolean).length > 1, JSON.stringify(counts));
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

  test("shares only completed query-independent App page artifacts across user queries", async () => {
    // Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
    const first = await cacheStatus("/query-independent?q=first");
    const second = await cacheStatus("/query-independent?q=second");
    assert.equal(second.status, "HIT");
    assert.equal(
      htmlValue(first.body, "query-independent-id"),
      htmlValue(second.body, "query-independent-id"),
    );

    const fromEmpty = await cacheStatus("/query-on-demand/a");
    const fromQuery = await cacheStatus("/query-on-demand/a?q=second");
    assert.equal(fromQuery.status, "HIT");
    assert.equal(
      htmlValue(fromEmpty.body, "query-on-demand-id"),
      htmlValue(fromQuery.body, "query-on-demand-id"),
    );
    const otherPath = await cacheStatus("/query-on-demand/b?q=second");
    assert.notEqual(
      htmlValue(fromEmpty.body, "query-on-demand-id"),
      htmlValue(otherPath.body, "query-on-demand-id"),
    );

    for (const pathname of [
      "/query-dependent",
      "/query-dependent?q=first",
      "/query-dependent?q=second",
    ]) {
      const firstDynamic = await cacheStatus(pathname);
      const secondDynamic = await cacheStatus(pathname);
      assert.notEqual(firstDynamic.status, "HIT");
      assert.notEqual(secondDynamic.status, "HIT");
      assert.equal(
        htmlValue(secondDynamic.body, "query-dependent-value"),
        new URL(pathname, "https://app.test").searchParams.get("q") || "(empty)",
      );
      assert.notEqual(
        htmlValue(firstDynamic.body, "query-dependent-id"),
        htmlValue(secondDynamic.body, "query-dependent-id"),
      );
    }

    // A Client Page's empty-query prop is serialized before its component can
    // read it. A cached empty-query response must never answer a later query.
    const clientEmpty = await cacheStatus("/query-client-dependent");
    const clientWithQuery = await cacheStatus("/query-client-dependent?q=second");
    assert.notEqual(clientWithQuery.status, "HIT");
    assert.equal(htmlValue(clientEmpty.body, "query-client-dependent-value"), "(empty)");
    assert.equal(htmlValue(clientWithQuery.body, "query-client-dependent-value"), "second");
    assert.notEqual((await cacheStatus("/query-client-dependent")).status, "HIT");

    const forced = await cacheStatus("/query-force-static?q=ignored");
    assert.equal(htmlValue(forced.body, "query-force-static-value"), "(empty)");
    assert.equal((await cacheStatus("/query-force-static?q=different")).status, "HIT");

    const firstWithQuery = await cacheStatus("/query-independent?reverse=first");
    const afterQuery = await cacheStatus("/query-independent");
    assert.equal(firstWithQuery.status, "HIT");
    assert.equal(afterQuery.status, "HIT");

    const error = await cacheStatus("/query-error?q=ignored");
    assert.equal((await cacheStatus("/query-error?q=another")).status, "HIT");
    assert.equal(htmlValue(error.body, "query-error-id").length > 0, true);
  });

  test("keeps explicitly public query-dependent pages partitioned by the full query", async () => {
    for (const [query, value] of [
      ["?q=first", "first"],
      ["?q=second", "second"],
    ]) {
      const first = await cacheStatus(`/query-public${query}`);
      const second = await cacheStatus(`/query-public${query}`);
      assert.equal(first.status, "MISS");
      assert.equal(second.status, "HIT");
      assert.equal(htmlValue(second.body, "query-public-value"), value);
      assert.equal(
        htmlValue(first.body, "query-public-id"),
        htmlValue(second.body, "query-public-id"),
      );
    }
  });

  test("does not publish query-dependent metadata and does not alias rewritten paths", async () => {
    for (const query of ["", "?q=first", "?q=second"]) {
      const first = await cacheStatus(`/query-metadata${query}`);
      const second = await cacheStatus(`/query-metadata${query}`);
      assert.notEqual(first.status, "HIT");
      assert.notEqual(second.status, "HIT");
      assert.match(second.body, new RegExp(`Query metadata: ${query ? query.slice(3) : ""}`));
    }
    const source = await cacheStatus("/query-alias/rewrite?q=one");
    const repeat = await cacheStatus("/query-alias/rewrite?q=two");
    assert.equal(repeat.status, "HIT");
    assert.equal(
      htmlValue(source.body, "query-on-demand-id"),
      htmlValue(repeat.body, "query-on-demand-id"),
    );
    const destination = await cacheStatus("/query-on-demand/rewrite?q=three");
    assert.equal(destination.status, "MISS");
  });

  test("keeps HTML and RSC separate while sharing each query-independent representation", async () => {
    const pathname = "/query-on-demand/representations";
    const html = await cacheStatus(`${pathname}?q=html`);
    assert.equal(html.status, "MISS");

    const rscHeaders = { Accept: "text/x-component", RSC: "1" };
    const firstRsc = await request(`${pathname}?q=first&_rsc=first`, { headers: rscHeaders });
    const firstBody = await firstRsc.text();
    assert.equal(firstRsc.headers.get("x-vinext-cache"), "MISS");
    assert.match(firstRsc.headers.get("content-type") ?? "", /^text\/x-component/);

    const secondRsc = await request(`${pathname}?q=second&_rsc=second`, {
      headers: rscHeaders,
    });
    assert.equal(secondRsc.headers.get("x-vinext-cache"), "HIT");
    assert.equal(await secondRsc.text(), firstBody);
    assert.equal(
      decodeURIComponent(secondRsc.headers.get("x-vinext-rendered-path-and-search") ?? ""),
      `${pathname}?q=second`,
    );

    const secondHtml = await cacheStatus(`${pathname}?q=other`);
    assert.equal(secondHtml.status, "HIT");
    assert.equal(
      htmlValue(secondHtml.body, "query-on-demand-id"),
      htmlValue(html.body, "query-on-demand-id"),
    );
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

    // A different query on `pathname` now selects the same completed App page
    // artifact. Use a distinct ISR pathname to exercise a genuinely cold fill.
    const retryPath = "/cached/intro-retry";
    const storedHtml = await request(retryPath);
    assert.equal(storedHtml.headers.get("x-vinext-cache"), "MISS");
    await storedHtml.arrayBuffer();

    const retriedWarmup = await request(retryPath, {
      headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
    });
    assert.equal(retriedWarmup.headers.get("x-vinext-cache"), "MISS");
    await retriedWarmup.arrayBuffer();

    const repairedRsc = await request(`${retryPath}?_rsc`, {
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
    const previousEntryCount = (await metadataEntries()).flat().length;
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
      const entryCount = (await metadataEntries()).flat().length;
      if (entryCount > previousEntryCount) {
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

    const serialized = JSON.stringify((await metadataEntries()).flat());
    assert.doesNotMatch(serialized, /first-secret|second-secret/);
  });

  test("keeps concurrent cold renders successful", async () => {
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
    const entries = (await metadataEntries()).flat() as Array<{
      revalidator?: { args?: unknown[]; id?: unknown };
    }>;
    const cacheFunctionEntry = entries.find(
      (entry) => entry.revalidator?.id === "vinext:cache-function",
    );
    assert.ok(cacheFunctionEntry);
    const serializedInvocation = cacheFunctionEntry.revalidator?.args?.[1];
    assert.ok(typeof serializedInvocation === "string");
    const invocation = JSON.parse(serializedInvocation) as { referenceId?: unknown };
    assert.ok(typeof invocation.referenceId === "string");
    assert.match(invocation.referenceId, /^[0-9a-f]{12}#\$\$vinext_cache_[0-9a-f]{64}$/);

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
    assert.match(objects.objects[0].key, /\/r2-v1\/shards-4\/[0-9a-f]{64}\/active$/);
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
