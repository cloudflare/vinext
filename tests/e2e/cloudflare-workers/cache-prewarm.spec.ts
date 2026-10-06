import { testPagesStoragePolicies } from "../pages-storage-policy";
import { testRouteHandlerStoragePolicies } from "../route-handler-storage-policy";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { waitForStablePromotion } from "./promotion.js";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;
const verificationStartedAt = Date.now();

// Every deployed test must wait for stable promotion away from the seed Worker.
test.beforeAll(async ({ baseURL, playwright }) => {
  if (!backend || !baseURL?.startsWith("https://")) return;
  test.setTimeout(150_000);
  const buildId = fs
    .readFileSync("examples/response-store-demo/dist/server/BUILD_ID", "utf-8")
    .trim();
  const rscBuildId = fs
    .readFileSync("examples/response-store-demo/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();
  await waitForStablePromotion({ baseURL, buildId, rscBuildId, playwright });
});

// Ported from Next.js custom-cache-control behavior and issue #3538's proxy repro.
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
const browserPolicies = {
  browser: "max-age=10",
  shared: "public, max-age=10, s-maxage=3600, stale-while-revalidate=60",
  independent: "max-age=10, stale-while-revalidate=60",
  private: "private, max-age=10",
  "private-only": "private, max-age=10",
  "no-cache": "public, max-age=10, no-cache",
  "no-store": "no-store",
  "edge-no-store": "public, max-age=10",
  "bot-blocked": "max-age=10",
  proxy: "public, max-age=10",
};
const hasResponseCache = backend === "response-store" || backend === "workers-cache";
const cacheStatusHeader = backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache";

for (const [policy, expected] of Object.entries(browserPolicies)) {
  test(`preserves Next.js browser cache policy: ${policy}`, async ({ baseURL, request }) => {
    test.skip(!baseURL || !backend, "requires a configured response-store-demo backend");
    if (!baseURL) throw new Error("test requires a base URL");
    const mayStore = !["no-store", "private-only", "edge-no-store", "shared"].includes(policy);
    function expectPolicy(headers: Record<string, string>) {
      expect(headers["cache-control"], JSON.stringify(headers)).toBe(expected);
      if (!mayStore) expect(headers[cacheStatusHeader]).not.toBe("HIT");
      if (hasResponseCache) {
        expect(headers["cloudflare-cdn-cache-control"]).toBeUndefined();
        expect(headers["cdn-cache-control"]).toBeUndefined();
        expect(headers["x-vinext-cloudflare-shared-response-stage"]).toBeUndefined();
      }
    }
    const renderIds: string[] = [];
    for (const method of ["GET", "HEAD"]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request.fetch(`${baseURL}/api/browser-cache-policy/${policy}`, {
          method,
          headers:
            policy === "private-only" ? { "x-private-visitor": `visitor-${attempt}` } : undefined,
        });
        expect(response.status()).toBe(200);
        if (policy === "private-only")
          expect(response.headers()["x-private-visitor"]).toBe(`visitor-${attempt}`);
        expectPolicy(response.headers());
        if (method === "GET") {
          const body = await response.json();
          expect(body).toMatchObject({ policy, renderId: expect.any(String) });
          renderIds.push(body.renderId);
        }
        await response.dispose();
      }
    }
    if (!mayStore) expect(new Set(renderIds).size).toBe(2);
    if (
      mayStore &&
      hasResponseCache &&
      (backend !== "workers-cache" || baseURL.startsWith("https://"))
    ) {
      let hitHeaders: Record<string, string> = {};
      await expect
        .poll(
          async () => {
            const response = await request.get(`${baseURL}/api/browser-cache-policy/${policy}`);
            hitHeaders = response.headers();
            await response.dispose();
            return hitHeaders[cacheStatusHeader];
          },
          { timeout: 15_000 },
        )
        .toBe("HIT");
      expectPolicy(hitHeaders);
    }
    if (policy === "bot-blocked") {
      // A normal request has populated the shared entry before the bot arrives.
      for (const method of ["GET", "HEAD"]) {
        const response = await request.fetch(`${baseURL}/api/browser-cache-policy/${policy}`, {
          method,
          headers: { "User-Agent": "GPTBot/1.2" },
        });
        expect(response.status()).toBe(403);
        expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
      }
    }
  });
}

test("browser caches private responses without putting them in the backing store", async ({
  baseURL,
  page,
  request,
}) => {
  test.skip(!baseURL || !backend, "requires a configured response-store-demo backend");
  await page.goto(`${baseURL}/api/browser-cache-policy/private-only`);
  const read = () =>
    page.evaluate(async () => {
      const response = await fetch(location.href);
      return { policy: response.headers.get("cache-control"), body: await response.json() };
    });
  const first = await read();
  const second = await read();
  expect(first.policy).toBe("private, max-age=10");
  expect(second).toEqual(first);
  const direct = await request.get(`${baseURL}/api/browser-cache-policy/private-only`);
  expect(direct.headers()[cacheStatusHeader]).not.toBe("HIT");
  expect((await direct.json()).renderId).not.toBe(first.body.renderId);
});

test("backing store freshness follows its own policy in both directions", async ({
  baseURL,
  request,
}) => {
  test.setTimeout(60_000);
  test.skip(!baseURL || !backend, "requires a configured response-store-demo backend");
  test.skip(
    backend === "workers-cache" && !baseURL?.startsWith("https://"),
    "local workerd has no Workers Cache",
  );
  const read = async (policy: string) => {
    const response = await request.get(`${baseURL}/api/browser-cache-policy/${policy}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe(
      policy === "short-browser" ? "max-age=1" : "max-age=3600",
    );
    return { body: await response.json(), cache: response.headers()[cacheStatusHeader] };
  };
  let first = await read("short-browser");
  if (hasResponseCache) {
    await expect
      .poll(
        async () => {
          first = await read("short-browser");
          return first.cache;
        },
        { timeout: 15_000 },
      )
      .toBe("HIT");
  }
  const shortStore = await read("short-store");
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const later = await read("short-browser");
  if (hasResponseCache) {
    expect(later.cache).toBe("HIT");
    expect(later.body.renderId).toBe(first.body.renderId);
  } else {
    expect(later.body.renderId).not.toBe(first.body.renderId);
  }
  await expect
    .poll(async () => (await read("short-store")).body.renderId, { timeout: 15_000 })
    .not.toBe(shortStore.body.renderId);
});

for (const policy of ["middleware", "config"]) {
  test(`preserves browser cache policy across ${policy} routing`, async ({ baseURL, request }) => {
    test.skip(!baseURL || !backend, "requires a configured response-store-demo backend");
    // The first request deliberately does not match the conditional config rule.
    // The app owns its explicit browser policy; each network request still runs routing.
    for (const visitor of ["anonymous", "config-a", "config-b"]) {
      const response = await request.get(`${baseURL}/api/browser-cache-policy/${policy}`, {
        headers: { "x-test-visitor-id": visitor, "x-test-config-visitor": visitor },
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("max-age=10");
      const header =
        policy === "middleware" ? "x-workers-cache-visitor" : "x-workers-config-visitor";
      expect(response.headers()[header]).toBe(
        policy === "config" && visitor === "anonymous" ? undefined : visitor,
      );
      expect(await response.json()).toMatchObject({ policy });
      await response.dispose();
    }
  });
}

test("deployment pre-warming and force-dynamic bypass work with the configured cache", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(90_000);

  const rscBuildId = fs
    .readFileSync("examples/response-store-demo/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();

  const warmed = await request.get(`${baseURL}/cached/intro`, {
    headers: { accept: "text/html" },
  });
  const warmedHeaders = warmed.headers();
  expect(warmed.ok(), JSON.stringify(warmedHeaders)).toBe(true);
  if (backend === "workers-cache") {
    expect(["HIT", "MISS", "UPDATING"], JSON.stringify(warmedHeaders)).toContain(
      warmedHeaders["cf-cache-status"],
    );
  } else {
    // The stability gate exceeds this page's 60-second ISR freshness.
    // Stale reuse is valid; its 300-second data entry must still predate verification.
    expect(
      backend === "kv" ? ["HIT", "STALE"] : ["HIT", "UPDATING"],
      JSON.stringify(warmedHeaders),
    ).toContain(warmedHeaders["x-vinext-cache"]);
  }
  const warmedBody = await warmed.text();
  const warmedDataId = /data-cache-id[^>]*>([^<]+)</.exec(warmedBody)?.[1];
  expect(warmedDataId).toBeTruthy();
  const cachedAt = Number(/data-cache-created-at[^>]*>([^<]+)</.exec(warmedBody)?.[1]);
  expect(cachedAt).toBeLessThan(verificationStartedAt + 1_000);

  if (backend === "workers-cache" && warmedHeaders["cf-cache-status"] === "MISS") {
    const reused = await request.get(`${baseURL}/cached/intro`, {
      headers: { accept: "text/html" },
    });
    expect(reused.headers()["cf-cache-status"], JSON.stringify(reused.headers())).toBe("HIT");
    await reused.dispose();
  }

  // This route is explicitly no-store, so neither response-cache implementation
  // can satisfy it. It calls the same cached function as the page and therefore
  // proves that deployment warmup populated the configured data adapter.
  const probe = await request.get(
    `${baseURL}/api/cache-prewarm-probe/intro?cache-e2e=${randomUUID()}`,
  );
  const probeHeaders = probe.headers();
  expect(probe.ok(), JSON.stringify(probeHeaders)).toBe(true);
  expect(probeHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(probeHeaders["cache-control"]).toContain("no-store");
  const probeBody = (await probe.json()) as { cacheId: string; cachedAt: number; slug: string };
  expect(probeBody).toEqual({
    cacheId: warmedDataId,
    cachedAt,
    slug: "intro",
  });

  const dynamicUrl = `${baseURL}/force-dynamic?cache-e2e=${randomUUID()}`;
  const firstDynamic = await request.get(dynamicUrl);
  const secondDynamic = await request.get(dynamicUrl);
  const firstDynamicHeaders = firstDynamic.headers();
  const secondDynamicHeaders = secondDynamic.headers();
  expect(firstDynamic.ok(), JSON.stringify(firstDynamicHeaders)).toBe(true);
  expect(secondDynamic.ok(), JSON.stringify(secondDynamicHeaders)).toBe(true);
  expect(firstDynamicHeaders["cache-control"]).toContain("no-store");
  expect(secondDynamicHeaders["cache-control"]).toContain("no-store");
  expect(firstDynamicHeaders["x-vinext-cache"]).not.toBe("HIT");
  expect(secondDynamicHeaders["x-vinext-cache"]).not.toBe("HIT");
  expect(firstDynamicHeaders["cf-cache-status"]).not.toBe("HIT");
  expect(secondDynamicHeaders["cf-cache-status"]).not.toBe("HIT");
  const renderId = /force-dynamic-render-id[^>]*>([^<]+)</.exec(await firstDynamic.text())?.[1];
  const nextRenderId = /force-dynamic-render-id[^>]*>([^<]+)</.exec(
    await secondDynamic.text(),
  )?.[1];
  expect(renderId).toBeTruthy();
  expect(nextRenderId).toBeTruthy();
  expect(nextRenderId).not.toBe(renderId);
});

test("a dynamic-segment route without generateStaticParams is never cached", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");

  // Next.js renders this route per request even though it sets `revalidate`.
  const url = `${baseURL}/dynamic-segment/${randomUUID()}`;
  const renderIds: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.get(url);
    const headers = response.headers();
    expect(response.ok(), JSON.stringify({ backend, headers })).toBe(true);
    // Workers Cache admission rewrites a denied response to its own no-store
    // policy, so only the no-store directive is common to every backend.
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-vinext-cache"]).not.toBe("HIT");
    expect(headers["cf-cache-status"]).not.toBe("HIT");
    const renderId = /dynamic-segment-render-id[^>]*>([^<]+)</.exec(await response.text())?.[1];
    expect(renderId).toBeTruthy();
    renderIds.push(renderId!);
  }
  expect(renderIds[1]).not.toBe(renderIds[0]);
});

test("a static page with no revalidate source is served from the configured cache", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(60_000);

  // Next.js defaults a static page to `revalidate = false`. The deploy may have
  // warmed it already, so wait for two consecutive responses from one render.
  const renderIds: string[] = [];
  await expect
    .poll(
      async () => {
        const response = await request.get(`${baseURL}/static-default`);
        expect(response.ok(), JSON.stringify({ backend, headers: response.headers() })).toBe(true);
        const renderId = /static-default-render-id[^>]*>([^<]+)</.exec(await response.text())?.[1];
        expect(renderId).toBeTruthy();
        renderIds.push(renderId!);
        return renderIds.length > 1 && renderIds.at(-1) === renderIds.at(-2);
      },
      { intervals: [1_000], timeout: 45_000 },
    )
    .toBe(true);
});

test("useSearchParams() inside Suspense keeps the query out of a static page", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");

  const query = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.get(`${baseURL}/search-params/suspense?q=${query}`);
    const body = await response.text();
    expect(response.ok(), JSON.stringify({ backend, headers: response.headers() })).toBe(true);
    // The server renders the fallback, and the browser reads the query.
    expect(body).toContain('data-testid="search-fallback"');
    expect(body).not.toContain(query);
  }
});

test("useSearchParams() outside Suspense fails an on-demand static path", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");

  const url = `${baseURL}/search-params/unwrapped/${randomUUID()}?q=${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.get(url);
    await response.dispose();
    expect(response.status(), JSON.stringify({ backend, headers: response.headers() })).toBe(500);
  }
});

test("useSearchParams() server-renders the real query once the page is dynamic", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");

  const query = randomUUID();
  const response = await request.get(`${baseURL}/search-params/dynamic?q=${query}`);
  const headers = response.headers();
  expect(response.ok(), JSON.stringify({ backend, headers })).toBe(true);
  expect(/search-value[^>]*>([^<]+)</.exec(await response.text())?.[1]).toBe(query);
  expect(headers["x-vinext-cache"]).not.toBe("HIT");
  expect(headers["cf-cache-status"]).not.toBe("HIT");
});

test("Workers Cache serves every query of a static page from one entry", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  test.skip(backend !== "workers-cache", "the query-free dispatch is specific to Workers Cache");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(180_000);

  // Next.js serves a static page's one render for any query. Each request
  // carries a query no earlier request used, so only an entry shared across
  // queries can report a HIT with the previous response's render. No query
  // ever reaches the shared render.
  const expectSharedAcrossQueries = async (
    label: string,
    urlFor: (query: string) => string,
    headers: Record<string, string>,
    content: string,
    renderOf: (body: string) => string | undefined,
  ) => {
    const queries: string[] = [];
    let previousRender: string | undefined;
    await expect
      .poll(
        async () => {
          const query = randomUUID();
          queries.push(query);
          const response = await request.get(urlFor(query), { headers });
          const responseHeaders = response.headers();
          const trace = JSON.stringify({ label, headers: responseHeaders });
          expect(response.ok(), trace).toBe(true);
          const body = await response.text();
          expect(body, trace).toContain(content);
          for (const sent of queries) expect(body, trace).not.toContain(sent);
          const render = renderOf(body);
          expect(render, trace).toBeTruthy();
          const shared = responseHeaders["cf-cache-status"] === "HIT" && render === previousRender;
          previousRender = render;
          return shared;
        },
        { intervals: [1_000], timeout: 45_000 },
      )
      .toBe(true);
  };

  await expectSharedAcrossQueries(
    "HTML",
    (query) => `${baseURL}/cached/featured?q=${query}`,
    { accept: "text/html" },
    "Post: featured",
    (body) => /data-render-id-tag[^>]*>([^<]+)</.exec(body)?.[1],
  );
  // The canonical navigation RSC request: no router-state headers, so its
  // validated `_rsc` value is empty.
  await expectSharedAcrossQueries(
    "RSC navigation",
    (query) => `${baseURL}/cached/featured?q=${query}&_rsc`,
    { accept: "text/x-component", rsc: "1" },
    "Post: featured",
    // A HIT returns the stored payload byte for byte.
    (body) => body,
  );
  // A static page that reads useSearchParams() inside Suspense: Next.js
  // prerenders it once with the fallback, and the browser reads the query.
  await expectSharedAcrossQueries(
    "HTML with useSearchParams() inside Suspense",
    (query) => `${baseURL}/search-params/suspense?q=${query}`,
    { accept: "text/html" },
    'data-testid="search-fallback"',
    (body) => /search-suspense-render-id[^>]*>([^<]+)</.exec(body)?.[1],
  );
});

if (backend) {
  testRouteHandlerStoragePolicies();
  testPagesStoragePolicies();
}
