import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;

test("deployment pre-warming and force-dynamic bypass work with the configured cache", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(90_000);

  const testStartedAt = Date.now();
  const buildId = fs
    .readFileSync("examples/response-store-demo/dist/server/BUILD_ID", "utf-8")
    .trim();
  const rscBuildId = fs
    .readFileSync("examples/response-store-demo/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();
  const deadline = Date.now() + 60_000;
  let consecutiveReady = 0;

  do {
    const readiness = await request.get(`${baseURL}/api/prewarm-version?readiness=${randomUUID()}`);
    if (readiness.ok() && readiness.headers()["x-vinext-seed-worker"] !== "1") {
      const body = (await readiness.json()) as { buildId?: string };
      consecutiveReady = body.buildId === buildId ? consecutiveReady + 1 : 0;
    } else {
      consecutiveReady = 0;
    }
    await readiness.dispose();
    if (consecutiveReady === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);

  expect(consecutiveReady, `${backend} Worker did not finish promotion`).toBe(5);

  const warmed = await request.get(`${baseURL}/cached/intro`, {
    headers: { accept: "text/html" },
  });
  const warmedHeaders = warmed.headers();
  expect(warmed.ok(), JSON.stringify(warmedHeaders)).toBe(true);
  if (backend === "workers-cache") {
    expect(["HIT", "MISS"], JSON.stringify(warmedHeaders)).toContain(
      warmedHeaders["cf-cache-status"],
    );
  } else {
    expect(warmedHeaders["x-vinext-cache"], JSON.stringify(warmedHeaders)).toBe("HIT");
  }
  const warmedBody = await warmed.text();
  const warmedDataId = /data-cache-id[^>]*>([^<]+)</.exec(warmedBody)?.[1];
  expect(warmedDataId).toBeTruthy();
  const cachedAt = Number(/data-cache-created-at[^>]*>([^<]+)</.exec(warmedBody)?.[1]);
  expect(cachedAt).toBeLessThan(testStartedAt + 1_000);

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
  test.setTimeout(60_000);

  // Next.js serves a static page's one render for any query. Each request
  // carries a query no earlier request used, so only an entry shared across
  // queries can report a HIT with the previous response's render.
  let previousRenderId: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${baseURL}/cached/featured?q=${randomUUID()}`, {
          headers: { accept: "text/html" },
        });
        const headers = response.headers();
        expect(response.ok(), JSON.stringify(headers)).toBe(true);
        const renderId = /data-render-id-tag[^>]*>([^<]+)</.exec(await response.text())?.[1];
        expect(renderId).toBeTruthy();
        const shared = headers["cf-cache-status"] === "HIT" && renderId === previousRenderId;
        previousRenderId = renderId;
        return shared;
      },
      { intervals: [1_000], timeout: 45_000 },
    )
    .toBe(true);
});
