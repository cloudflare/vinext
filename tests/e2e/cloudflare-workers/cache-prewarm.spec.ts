import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;

test("deployment pre-warming and force-dynamic bypass work with the configured cache", async ({
  baseURL,
  page,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(180_000);

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

  // The demo is deployed with each cache adapter. A statically observed App
  // page reuses its artifact across user queries; query-dependent output must
  // retain the query that produced it.
  const suffix = randomUUID();
  const independentFirst = await request.get(`${baseURL}/query-independent?q=first-${suffix}`);
  const firstIndependentBody = await independentFirst.text();
  expect(independentFirst.ok()).toBe(true);
  const independentSecond = await request.get(`${baseURL}/query-independent?q=second-${suffix}`);
  const secondIndependentBody = await independentSecond.text();
  expect(independentSecond.ok()).toBe(true);
  expect(secondIndependentBody).toBe(firstIndependentBody);
  expect(secondIndependentBody).not.toContain(`first-${suffix}`);
  expect(secondIndependentBody).toContain("searchParamsFromBrowser:true");
  expect(
    independentSecond.headers()[backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache"],
  ).toBe("HIT");
  await page.goto(`${baseURL}/query-independent?q=second-${suffix}`);
  await expect(page.getByTestId("query-independent-client-value")).toHaveText(`second-${suffix}`);

  const cacheStatusHeader = backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache";
  let forceStaticFirstBody = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${baseURL}/query-force-static/${suffix}?q=first-${suffix}`,
        );
        const status = response.status();
        const cacheStatus = response.headers()[cacheStatusHeader];
        const body = await response.text();
        await response.dispose();
        if (status < 200 || status >= 300) return `HTTP ${status}`;
        if (cacheStatus === "HIT") forceStaticFirstBody = body;
        return cacheStatus;
      },
      { message: `${backend} did not publish the force-static response`, timeout: 30_000 },
    )
    .toBe("HIT");
  const forceStaticSecond = await request.get(
    `${baseURL}/query-force-static/${suffix}?q=second-${suffix}`,
  );
  const forceStaticSecondBody = await forceStaticSecond.text();
  expect(forceStaticSecond.ok()).toBe(true);
  expect(forceStaticSecondBody).toBe(forceStaticFirstBody);
  expect(forceStaticSecondBody).not.toContain(`first-${suffix}`);
  expect(forceStaticSecondBody).not.toContain("searchParamsFromBrowser:true");
  expect(forceStaticSecondBody).toContain(
    'data-testid="query-force-static-client-value">(empty)</output>',
  );
  await page.goto(`${baseURL}/query-force-static/${suffix}?q=second-${suffix}`);
  await expect(page.getByTestId("query-force-static-client-value")).toHaveText("(empty)");
  expect(forceStaticSecond.headers()[cacheStatusHeader]).toBe("HIT");

  // The ordinary static route above has an HTML-only manifest certificate.
  // An explicit force-static route certifies both HTML and RSC on-demand.
  const rscHeaders = { accept: "text/x-component", RSC: "1" };
  let forceStaticRscBody = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${baseURL}/query-force-static/${suffix}?q=first-${suffix}&_rsc=first-${suffix}`,
          { headers: rscHeaders },
        );
        const cacheStatus = response.headers()[cacheStatusHeader];
        if (cacheStatus === "HIT") forceStaticRscBody = await response.text();
        await response.dispose();
        return cacheStatus;
      },
      { message: `${backend} did not publish the force-static RSC response`, timeout: 30_000 },
    )
    .toBe("HIT");
  const forceStaticSecondRsc = await request.get(
    `${baseURL}/query-force-static/${suffix}?q=second-${suffix}&_rsc=second-${suffix}`,
    { headers: rscHeaders },
  );
  expect(forceStaticSecondRsc.ok()).toBe(true);
  expect(forceStaticSecondRsc.headers()["content-type"]).toContain("text/x-component");
  expect(await forceStaticSecondRsc.text()).toBe(forceStaticRscBody);
  expect(forceStaticSecondRsc.headers()[cacheStatusHeader]).toBe("HIT");
  if (backend !== "kv") {
    expect(
      decodeURIComponent(forceStaticSecondRsc.headers()["x-vinext-rendered-path-and-search"] ?? ""),
    ).toBe(`/query-force-static/${suffix}?q=second-${suffix}`);
  }

  // A force-static Route Handler strips the query and reuses its pathname artifact.
  // Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  const handlerFirst = await request.get(`${baseURL}/api/query-handler-static?q=first-${suffix}`);
  expect(handlerFirst.ok(), JSON.stringify(handlerFirst.headers())).toBe(true);
  const firstHandlerBody = await handlerFirst.json();
  const handlerSecond = await request.get(`${baseURL}/api/query-handler-static?q=second-${suffix}`);
  expect(handlerSecond.ok(), JSON.stringify(handlerSecond.headers())).toBe(true);
  expect(await handlerSecond.json()).toEqual(firstHandlerBody);
  expect(firstHandlerBody.search).toBe("");
  if (backend !== "kv") expect(handlerSecond.headers()[cacheStatusHeader]).toBe("HIT");

  for (const path of ["query-dependent", "query-client-dependent", "query-prop-to-client"]) {
    // The empty-query response is a particularly dangerous source of false
    // static certification: its thenable carries no enumerable query keys.
    for (const query of ["", `?q=first-${suffix}`, `?q=second-${suffix}`, ""]) {
      const url = `${baseURL}/${path}${query}`;
      const first = await request.get(url);
      const second = await request.get(url);
      expect(first.ok(), `${path}: ${JSON.stringify(first.headers())}`).toBe(true);
      expect(second.ok(), `${path}: ${JSON.stringify(second.headers())}`).toBe(true);
      const expected = new URL(url).searchParams.get("q") || "(empty)";
      for (const response of [first, second]) {
        // Direct KV's fresh empty-query Client Page currently carries no
        // cache policy, but must never produce a cache hit. The two edge
        // adapters explicitly mark it no-store.
        if (backend !== "kv" || path !== "query-client-dependent" || query !== "") {
          expect(response.headers()["cache-control"]).toContain("no-store");
        }
        expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
        expect(await response.text()).toContain(`data-testid="${path}-value">${expected}</output>`);
      }
    }
  }

  for (const query of ["", `?q=first-${suffix}`, `?q=second-${suffix}`]) {
    const url = `${baseURL}/query-ssr-client/${suffix}${query}`;
    for (const response of [await request.get(url), await request.get(url)]) {
      const body = await response.text();
      expect(
        response.ok(),
        `${url}: ${JSON.stringify(response.headers())} ${body.slice(0, 400)}`,
      ).toBe(true);
      expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(body).toContain(
        `data-testid="query-ssr-client-value">${new URL(url).searchParams.get("q") || "(empty)"}</output>`,
      );
    }
  }

  const rewriteWithQuery = await request.get(
    `${baseURL}/query-alias-fixed/${suffix}?q=first-${suffix}`,
  );
  expect(rewriteWithQuery.ok()).toBe(true);
  expect(await rewriteWithQuery.text()).not.toContain("searchParamsFromBrowser:true");
  const rewriteWithOtherQuery = await request.get(
    `${baseURL}/query-alias-fixed/${suffix}?q=second-${suffix}`,
  );
  expect(rewriteWithOtherQuery.ok()).toBe(true);
  if (backend !== "kv") {
    expect(rewriteWithOtherQuery.headers()[cacheStatusHeader]).not.toBe("HIT");
  }

  // Explicit public policy may cache a dynamic response, but only under its
  // *full* query. Response Store commits warmup synchronously, but another
  // isolate can retain a short-lived negative lookup after that commit.
  let previousPublicId: string | undefined;
  for (const value of [`first-${suffix}`, `second-${suffix}`]) {
    const url = `${baseURL}/query-public?q=${value}`;
    const first = await request.get(url, {
      headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
    });
    const firstBody = await first.text();
    expect(first.ok(), JSON.stringify(first.headers())).toBe(true);
    expect(firstBody).toContain(`data-testid="query-public-value">${value}</output>`);
    const publicId = /data-testid="query-public-id"[^>]*>([^<]+)/.exec(firstBody)?.[1];
    expect(publicId).toBeTruthy();
    expect(publicId).not.toBe(previousPublicId);
    if (backend !== "kv") {
      let hitBody = "";
      await expect
        .poll(
          async () => {
            const response = await request.get(url);
            const status = response.headers()[cacheStatusHeader];
            const body = await response.text();
            expect(response.ok(), JSON.stringify(response.headers())).toBe(true);
            if (status === "HIT") hitBody = body;
            await response.dispose();
            return status;
          },
          {
            message: `${backend} did not publish the query-specific public response`,
            timeout: 10_000,
          },
        )
        .toBe("HIT");
      expect(hitBody).toBe(firstBody);
      expect(hitBody).toContain(`data-testid="query-public-value">${value}</output>`);
    }
    previousPublicId = publicId;
  }

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
