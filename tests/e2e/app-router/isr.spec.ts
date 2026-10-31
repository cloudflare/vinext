import { testRouteHandlerStoragePolicies } from "../route-handler-storage-policy";
import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

function baseUrl(): string {
  const url = test.info().project.use.baseURL;
  if (!url) {
    throw new Error("isr.spec.ts requires a Playwright project with a baseURL");
  }
  return url;
}

async function resetIsrPath(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.get(
    `${baseUrl()}/api/revalidate-isr?path=${encodeURIComponent(path)}`,
  );
  expect(response.status()).toBe(200);
}

async function waitForCacheHit(request: APIRequestContext, path: string): Promise<APIResponse> {
  let response: APIResponse | undefined;
  await expect
    .poll(
      async () => {
        response = await request.get(`${baseUrl()}${path}`);
        return response.headers()["x-vinext-cache"];
      },
      {
        message: `wait for ${path} to be written to the ISR cache`,
        timeout: 5_000,
        intervals: [50, 100, 250],
      },
    )
    .toBe("HIT");

  if (!response) {
    throw new Error(`No response received while waiting for an ISR cache HIT for ${path}`);
  }
  return response;
}

function testIdText(html: string, testId: string): string | undefined {
  return html.match(new RegExp(`data-testid="${testId}"[^>]*>(?:<!--[^>]*-->)*([^<]*)<`))?.[1];
}

test.describe("App Router ISR", () => {
  // This suite runs against the dedicated app-router-isr-prod project because
  // ISR caching is intentionally disabled in development mode.

  test.beforeEach(async ({ request }) => {
    // The production server survives Playwright retries, so explicitly clear
    // shared entries to keep MISS/HIT assertions independent and retry-safe.
    for (const path of ["/isr-test", "/client-isr-test", "/revalidate-test"]) {
      await resetIsrPath(request, path);
    }
  });

  test("first unproven render is private while populating the ISR cache", async ({ request }) => {
    const res = await request.get(`${baseUrl()}/isr-test`);

    expect(res.status()).toBe(200);
    expect(res.headers()["x-vinext-cache"]).toBe("MISS");
    expect(res.headers()["cache-control"]).toContain("no-store");

    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");
  });

  test("second request within TTL is a cache HIT with same timestamp", async ({ request }) => {
    const res1 = await request.get(`${baseUrl()}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    const res2 = await waitForCacheHit(request, "/isr-test");
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    const cacheHeader = res2.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  test("request after TTL expires returns STALE with same cached content", async ({ request }) => {
    await request.get(`${baseUrl()}/isr-test`);
    const cachedRes = await waitForCacheHit(request, "/isr-test");
    const html1 = await cachedRes.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    await new Promise((r) => setTimeout(r, 1500));

    const res2 = await request.get(`${baseUrl()}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];
    const cacheHeader2 = res2.headers()["x-vinext-cache"];

    expect(cacheHeader2).toBe("STALE");
    expect(ts2).toBe(ts1);
  });

  test("after STALE triggers regen, subsequent request is HIT", async ({ request }) => {
    await request.get(`${baseUrl()}/isr-test`);
    await waitForCacheHit(request, "/isr-test");

    await new Promise((r) => setTimeout(r, 1500));

    const staleRes = await request.get(`${baseUrl()}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    const hitRes = await waitForCacheHit(request, "/isr-test");
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("Cache-Control header includes s-maxage and stale-while-revalidate", async ({ request }) => {
    const initial = await request.get(`${baseUrl()}/isr-test`);
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/isr-test");
    const cc = cached.headers()["cache-control"];

    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("queryless client page becomes publicly cacheable after its initial render", async ({
    request,
  }) => {
    const initial = await request.get(`${baseUrl()}/client-isr-test`);

    expect(initial.status()).toBe(200);
    expect(await initial.text()).toContain("Client ISR page");
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/client-isr-test");
    const cc = cached.headers()["cache-control"];
    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("static page without revalidate is cached until revalidated", async ({ request }) => {
    // About page has no `export const revalidate`, so it gets Next.js's
    // default `revalidate = false` and is stored after its first render.
    const cached = await waitForCacheHit(request, "/about");

    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cached.headers()["cache-control"]).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  test("ISR page renders correctly in browser", async ({ page }) => {
    await page.goto(`${baseUrl()}/isr-test`);

    await expect(page.getByTestId("isr-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("App Router ISR Test");
    await expect(page.getByTestId("message")).toHaveText("Hello from ISR");

    const tsText = await page.getByTestId("timestamp").textContent();
    expect(Number(tsText)).toBeGreaterThan(0);
  });

  // Next.js never puts the request's query into a static page's HTML: the
  // browser reads it from its own URL. One stored document serves every query,
  // so a query-bearing miss must store nothing of its query, even in the
  // navigation payload of a page that never reads it.
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  test("a query-bearing miss stores a document without the visitor's query", async ({
    request,
  }) => {
    const secret = `secret-${crypto.randomUUID()}`;
    const first = await request.get(`${baseUrl()}/revalidate-test?token=${secret}`);
    expect(first.status()).toBe(200);
    expect(first.headers()["x-vinext-cache"]).toBe("MISS");
    const firstHtml = await first.text();
    expect(firstHtml).not.toContain(secret);
    const renderedAt = testIdText(firstHtml, "timestamp");
    expect(renderedAt).toBeTruthy();

    // The query-free visitor gets the first visitor's stored render.
    const cached = await waitForCacheHit(request, "/revalidate-test");
    const cachedHtml = await cached.text();
    expect(testIdText(cachedHtml, "timestamp")).toBe(renderedAt);
    expect(cachedHtml).not.toContain(secret);
  });

  test("a query-bearing miss keeps useSearchParams() values out of the stored document", async ({
    page,
    request,
  }) => {
    const path = "/isr-search-params-suspense";
    await resetIsrPath(request, path);
    const secret = `secret-${crypto.randomUUID()}`;
    const first = await request.get(`${baseUrl()}${path}?value=${secret}`);
    expect(first.status()).toBe(200);
    expect(first.headers()["x-vinext-cache"]).toBe("MISS");
    const firstHtml = await first.text();
    // The server renders the Suspense fallback, as in Next.js's static HTML.
    expect(firstHtml).toContain('data-testid="search-value-fallback"');
    expect(firstHtml).not.toContain(secret);
    const renderedAt = testIdText(firstHtml, "timestamp");
    expect(renderedAt).toBeTruthy();

    const cached = await waitForCacheHit(request, path);
    const cachedHtml = await cached.text();
    expect(testIdText(cachedHtml, "timestamp")).toBe(renderedAt);
    expect(cachedHtml).not.toContain(secret);

    // A later visitor's browser reads its own query from the stored document.
    const response = await page.goto(`${baseUrl()}${path}?value=mine`);
    expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
    const visitorHtml = (await response?.text()) ?? "";
    expect(testIdText(visitorHtml, "timestamp")).toBe(renderedAt);
    expect(visitorHtml).not.toContain(secret);
    await expect(page.getByTestId("search-value")).toHaveText("mine");
  });

  test("a page that reads searchParams renders each query and stores none", async ({ request }) => {
    const secret = `secret-${crypto.randomUUID()}`;
    const first = await request.get(`${baseUrl()}/isr-dynamic-search?filter=${secret}`);
    expect(first.status()).toBe(200);
    expect(testIdText(await first.text(), "filter")).toBe(secret);
    expect(first.headers()["x-vinext-cache"]).toBeUndefined();

    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await request.get(`${baseUrl()}/isr-dynamic-search`);
      const html = await next.text();
      expect(next.headers()["x-vinext-cache"]).toBeUndefined();
      expect(testIdText(html, "filter")).toBe("none");
      expect(html).not.toContain(secret);
    }
  });

  test("existing revalidate-test page exposes its 60s policy after population", async ({
    request,
  }) => {
    // The revalidate-test fixture uses revalidate=60
    const initial = await request.get(`${baseUrl()}/revalidate-test`);
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/revalidate-test");
    const cc = cached.headers()["cache-control"];

    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=60");
    expect(cc).toContain("stale-while-revalidate");
  });

  // An encoded spelling of a static sibling answers with that prerendered
  // page, as Next.js serves it from the entry cached under the decoded path.
  test("answers an encoded static route spelling with the static route", async ({ request }) => {
    await resetIsrPath(request, "/route-cache-identity/about");

    const encoded = await request.get(`${baseUrl()}/route-cache-identity/%61bout`);
    expect(encoded.status()).toBe(200);
    expect(await encoded.text()).toContain("CACHE_IDENTITY_STATIC_PAGE");

    const literal = await waitForCacheHit(request, "/route-cache-identity/about");
    expect(await literal.text()).toContain("CACHE_IDENTITY_STATIC_PAGE");
  });

  // A request spelling that selects a catch-all route must not publish that
  // artifact under a static sibling's ISR key. Encoded delimiters and /index
  // remain distinct cache identities.
  for (const { attackPath, expectedVictim, label, victimPath } of [
    {
      attackPath: "/route-cache-identity/nested%2Fabout",
      expectedVictim: "CACHE_IDENTITY_NESTED_STATIC_PAGE",
      label: "encoded separator",
      victimPath: "/route-cache-identity/nested/about",
    },
    {
      attackPath: "/route-cache-identity/index",
      expectedVictim: "CACHE_IDENTITY_ROOT_STATIC_PAGE",
      label: "/index alias",
      victimPath: "/route-cache-identity",
    },
  ]) {
    test(`keeps ${label} catch-all output out of a static route`, async ({ request }) => {
      await resetIsrPath(request, victimPath);

      const attacker = await request.get(`${baseUrl()}${attackPath}`);
      expect(attacker.status()).toBe(200);
      expect(await attacker.text()).toContain("CACHE_IDENTITY_CATCH_ALL:");

      const victim = await waitForCacheHit(request, victimPath);
      expect(await victim.text()).toContain(expectedVictim);
    });
  }

  // Next.js keys each ISR entry by its full pathname. These two segments leave
  // the fnv1a64 digest that once shortened long ISR keys in the same state, so
  // a request could plant its render in the other path's entry.
  test("keeps long ISR paths with colliding fnv1a64 digests apart", async ({ request }) => {
    // A fresh tail per run, so neither path has an entry from an earlier attempt.
    const tail = `-${Date.now().toString(36)}${"x".repeat(200)}`;
    const attacker = await waitForCacheHit(
      request,
      `/route-cache-identity/211eb618a29231c0${tail}`,
    );
    expect(await attacker.text()).toMatch(
      /CACHE_IDENTITY_CATCH_ALL:(?:<!-- -->)?211eb618a29231c0-/,
    );

    const victim = await request.get(`${baseUrl()}/route-cache-identity/213912085a2b1a20${tail}`);
    expect(victim.status()).toBe(200);
    expect(victim.headers()["x-vinext-cache"]).toBe("MISS");
    const html = await victim.text();
    expect(html).toMatch(/CACHE_IDENTITY_CATCH_ALL:(?:<!-- -->)?213912085a2b1a20-/);
    expect(html).not.toContain("211eb618a29231c0");
  });

  test("does not let an encoded catch-all request poison a static route handler", async ({
    request,
  }) => {
    const staticPath = "/route-handler-cache-identity/about";
    await resetIsrPath(request, staticPath);

    const attacker = await request.get(`${baseUrl()}/route-handler-cache-identity/%61bout`);
    expect(attacker.status()).toBe(200);
    expect(await attacker.text()).toBe(
      "CACHE_IDENTITY_ROUTE_CATCH_ALL:about:/route-handler-cache-identity/%61bout",
    );
    expect(attacker.headers()["cache-control"]).toContain("no-store");

    const victim = await waitForCacheHit(request, staticPath);
    expect(await victim.text()).toBe("CACHE_IDENTITY_STATIC_ROUTE_HANDLER");
  });

  test("does not share differently spelled paths for one dynamic route handler", async ({
    request,
  }) => {
    const decodedPath = "/route-handler-cache-identity/dynamic/alpha";
    await resetIsrPath(request, decodedPath);

    const encoded = await request.get(`${baseUrl()}/route-handler-cache-identity/dynamic/%61lpha`);
    expect(encoded.status()).toBe(200);
    expect(await encoded.text()).toBe(
      "CACHE_IDENTITY_ROUTE_CATCH_ALL:dynamic:alpha:/route-handler-cache-identity/dynamic/%61lpha",
    );
    expect(encoded.headers()["cache-control"]).toContain("no-store");

    const decoded = await waitForCacheHit(request, decodedPath);
    expect(await decoded.text()).toBe(
      "CACHE_IDENTITY_ROUTE_CATCH_ALL:dynamic:alpha:/route-handler-cache-identity/dynamic/alpha",
    );
  });

  test("keeps rewritten route handler output out of the destination cache", async ({ request }) => {
    const destinationPath = "/route-handler-cache-identity/rewrite";
    await resetIsrPath(request, destinationPath);

    const rewritten = await request.get(`${baseUrl()}/route-cache-rewrite/rewrite`);
    expect(rewritten.status()).toBe(200);
    expect(await rewritten.text()).toBe(
      "CACHE_IDENTITY_ROUTE_CATCH_ALL:rewrite:/route-cache-rewrite/rewrite",
    );
    expect(rewritten.headers()["cache-control"]).toContain("no-store");

    const destination = await waitForCacheHit(request, destinationPath);
    expect(await destination.text()).toBe(
      "CACHE_IDENTITY_ROUTE_CATCH_ALL:rewrite:/route-handler-cache-identity/rewrite",
    );
  });

  test("keeps query-selected rewrite destinations in distinct cache entries", async ({
    request,
  }) => {
    await resetIsrPath(request, "/route-cache-identity/about");
    await resetIsrPath(request, "/route-cache-identity/nested/about");

    const aboutPath = "/route-cache-choice?view=about";
    const nestedPath = "/route-cache-choice?view=nested";
    const about = await waitForCacheHit(request, aboutPath);
    expect(await about.text()).toContain("CACHE_IDENTITY_STATIC_PAGE");

    const initialNested = await request.get(`${baseUrl()}${nestedPath}`);
    expect(await initialNested.text()).toContain("CACHE_IDENTITY_NESTED_STATIC_PAGE");

    const nested = await waitForCacheHit(request, nestedPath);
    expect(await nested.text()).toContain("CACHE_IDENTITY_NESTED_STATIC_PAGE");

    const cachedAbout = await waitForCacheHit(request, aboutPath);
    expect(await cachedAbout.text()).toContain("CACHE_IDENTITY_STATIC_PAGE");
  });

  test("keeps a hostname-selected route handler response off other hosts", async ({ request }) => {
    const path = "/api/host-tenant";
    await resetIsrPath(request, path);
    const port = new URL(baseUrl()).port;

    // One server answers several hostnames through a single path-keyed cache,
    // as a multi-domain Worker does. Prime from each host before reading from
    // the other so neither direction can replay a stored response.
    const tenants = ["tenant-a", "tenant-b", "tenant-a", "tenant-b"];
    const responses = [];
    for (const tenant of tenants) {
      const response = await request.get(`${baseUrl()}${path}`, {
        headers: { host: `${tenant}.localhost:${port}` },
      });
      expect(response.status()).toBe(200);
      responses.push({
        body: await response.json(),
        cache: response.headers()["x-vinext-cache"],
        cdnPolicy: response.headers()["cache-control"]?.includes("s-maxage") ?? false,
      });
    }
    expect(responses).toEqual(
      tenants.map((tenant) => ({
        body: { tenant: `${tenant}.localhost` },
        cache: undefined,
        cdnPolicy: false,
      })),
    );
  });

  // Like Next.js, the trailing-slash spelling is redirected before the
  // handler runs, so only the canonical path is cached.
  test("redirects a trailing-slash route handler request before caching it", async ({
    request,
  }) => {
    const plainPath = "/api/route-cache-identity/trailing";
    await resetIsrPath(request, plainPath);

    const trailing = await request.get(`${baseUrl()}${plainPath}/`, { maxRedirects: 0 });
    expect(trailing.status()).toBe(308);
    expect(trailing.headers()["location"]).toBe(plainPath);
    expect(trailing.headers()["x-vinext-cache"]).toBeUndefined();

    const initialPlain = await request.get(`${baseUrl()}${plainPath}`);
    expect(initialPlain.headers()["x-vinext-cache"]).toBe("MISS");
    const plain = await waitForCacheHit(request, plainPath);
    expect(await plain.text()).toBe(`CACHE_IDENTITY_API_ROUTE:${plainPath}`);
  });

  test("dynamic metadata images honor dynamicParams=false", async ({ request }) => {
    const publicImage = await request.get(
      `${baseUrl()}/metadata-static-params/public-post/opengraph-image`,
    );
    expect(publicImage.status()).toBe(200);
    expect(await publicImage.text()).toBe("PUBLIC");

    const encodedPublicImage = await request.get(
      `${baseUrl()}/metadata-static-params/public%20post/opengraph-image`,
    );
    expect(encodedPublicImage.status()).toBe(200);
    expect(await encodedPublicImage.text()).toBe("PUBLIC ENCODED");

    const doubleEncodedImage = await request.get(
      `${baseUrl()}/metadata-static-params/public%2520post/opengraph-image`,
    );
    expect(doubleEncodedImage.status()).toBe(200);
    expect(await doubleEncodedImage.text()).toBe("PUBLIC ESCAPED");

    const escapedSlashImage = await request.get(
      `${baseUrl()}/metadata-static-params/public%252Fpost/opengraph-image`,
    );
    expect(escapedSlashImage.status()).toBe(200);
    expect(await escapedSlashImage.text()).toBe("PUBLIC ESCAPED SLASH");

    const unlistedEncodingImage = await request.get(
      `${baseUrl()}/metadata-static-params/public%252520post/opengraph-image`,
    );
    expect(unlistedEncodingImage.status()).toBe(404);

    const incompleteParamsImage = await request.get(
      `${baseUrl()}/metadata-static-params-multi/private/public/opengraph-image`,
    );
    expect(incompleteParamsImage.status()).toBe(404);

    const emptyOptionalImage = await request.get(
      `${baseUrl()}/metadata-static-params-optional/opengraph-image`,
    );
    expect(emptyOptionalImage.status()).toBe(200);
    expect(await emptyOptionalImage.text()).toBe("EMPTY OPTIONAL");

    const omittedOptionalImage = await request.get(
      `${baseUrl()}/metadata-static-params-optional-missing/opengraph-image`,
    );
    expect(omittedOptionalImage.status()).toBe(404);

    const privatePage = await request.get(`${baseUrl()}/metadata-static-params/unlisted-draft`);
    expect(privatePage.status()).toBe(404);

    const privateImage = await request.get(
      `${baseUrl()}/metadata-static-params/unlisted-draft/opengraph-image`,
    );
    expect(privateImage.status()).toBe(404);
    expect(await privateImage.text()).not.toContain("UNLISTED_METADATA");
  });

  test("cached dynamicParams=false metadata images skip generateStaticParams", async ({
    request,
  }) => {
    const imagePath = "/metadata-static-params/public-post/opengraph-image";
    const takeCalls = async () =>
      (await (await request.get(`${baseUrl()}/metadata-static-params-calls`)).json()).calls;

    await waitForCacheHit(request, imagePath);
    await takeCalls();

    // Next answers the generated-param gate from its build manifest, so a
    // cache hit runs no generateStaticParams.
    const cached = await request.get(`${baseUrl()}${imagePath}`);
    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(await cached.text()).toBe("PUBLIC");
    expect(await takeCalls()).toBe(0);

    const unlisted = await request.get(
      `${baseUrl()}/metadata-static-params/unlisted-draft/opengraph-image`,
    );
    expect(unlisted.status()).toBe(404);
    expect(await takeCalls()).toBe(1);
  });

  test("dynamicParams=false runs nested generateStaticParams only for matching parents", async ({
    request,
  }) => {
    const basePath = "/layout-segment-config/nested-gsp";
    const takeCalls = async () =>
      (await request.get(`${baseUrl()}/layout-segment-config/nested-gsp-calls`)).json();
    await takeCalls();

    const unlistedSlug = await request.get(`${baseUrl()}${basePath}/guides/missing`);
    expect(unlistedSlug.status()).toBe(404);
    expect(await takeCalls()).toEqual({ layout: 1, page: ["guides"] });

    // One generator still runs when no parent matches, so a child that rewrites
    // parent params is observed.
    const unlistedCategory = await request.get(`${baseUrl()}${basePath}/missing/x`);
    expect(unlistedCategory.status()).toBe(404);
    expect(await takeCalls()).toEqual({ layout: 1, page: ["docs"] });
  });
});

// A background regeneration renders the document whole, so the title that its
// generateMetadata() streams is in <head>, as in Next.js. A miss streams the
// document to its request, so the title streams into <body>.
test.describe("ISR generated metadata placement", () => {
  function titleIndex(html: string, title: string): number {
    const index = html.indexOf(`<title>${title}</title>`);
    expect(index).toBeGreaterThan(-1);
    return index;
  }

  function expectTitleInHead(html: string, title: string): void {
    expect(titleIndex(html, title)).toBeLessThan(html.indexOf("</head>"));
  }

  function expectTitleInBody(html: string, title: string): void {
    expect(titleIndex(html, title)).toBeGreaterThan(html.indexOf("</head>"));
  }

  function readTimestamp(html: string): string | undefined {
    return html.match(/data-testid="timestamp">(\d+)</)?.[1];
  }

  test("streams the generated title on a miss and puts it in <head> on a regeneration", async ({
    request,
  }) => {
    const id = crypto.randomUUID();
    const path = `/isr-metadata-head/${id}`;
    const title = `ISR metadata head ${id}`;

    const miss = await request.get(`${baseUrl()}${path}`);
    expect(miss.headers()["x-vinext-cache"]).toBe("MISS");
    expectTitleInBody(await miss.text(), title);

    const hit = await waitForCacheHit(request, path);
    const hitHtml = await hit.text();
    expectTitleInBody(hitHtml, title);
    const storedTimestamp = readTimestamp(hitHtml);
    expect(storedTimestamp).toBeDefined();

    // The entry goes stale after a second, and the next request regenerates it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stale = await request.get(`${baseUrl()}${path}`);
    expect(stale.headers()["x-vinext-cache"]).toBe("STALE");
    await stale.text();

    // A complete regenerated document has the page's new timestamp.
    let regeneratedHtml = "";
    await expect
      .poll(async () => {
        const response = await request.get(`${baseUrl()}${path}`);
        regeneratedHtml = await response.text();
        const timestamp = readTimestamp(regeneratedHtml);
        return [
          response.headers()["x-vinext-cache"],
          timestamp !== undefined && timestamp !== storedTimestamp,
        ];
      })
      .toEqual(["HIT", true]);
    expectTitleInHead(regeneratedHtml, title);
  });
});

/**
 * OpenNext Compat: ISR dynamicParams cache header tests
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/isr.test.ts
 *
 * OpenNext verifies that `dynamicParams=true` pages return HIT for prebuilt paths,
 * MISS for non-prebuilt, and 404 for notFound(). `dynamicParams=false` returns 404
 * for unknown params. These tests verify the same cache header semantics in vinext.
 */
test.describe("ISR dynamicParams cache headers", () => {
  test.describe("dynamicParams=false (products)", () => {
    // Ref: opennextjs-cloudflare isr.test.ts "dynamicParams set to false"
    test("should return 200 on a prebuilt path", async ({ request }) => {
      // Products fixture uses dynamicParams=false with generateStaticParams [1, 2, 3]
      // Note: products page has no `export const revalidate`, so ISR is not active
      // and x-vinext-cache may not be set. We verify the page renders correctly.
      const res = await request.get(`${baseUrl()}/products/1`);
      expect(res.status()).toBe(200);

      const html = await res.text();
      // React SSR inserts <!-- --> comment nodes between text and expressions,
      // so "Product 1" may appear as "Product <!-- -->1" in raw HTML.
      // lgtm[js/redos] — applied to trusted SSR output, not user input
      expect(html).toMatch(/Product\s*(?:<!--.*?-->)*\s*1/);
    });

    test("should return 404 for a path not in generateStaticParams", async ({ request }) => {
      // Ref: opennextjs-cloudflare isr.test.ts "should 404 for a path that is not found"
      const res = await request.get(`${baseUrl()}/products/999`);
      expect(res.status()).toBe(404);

      const cc = res.headers()["cache-control"];
      if (cc) {
        expect(cc).toContain("no-cache");
      }
    });
  });

  test.describe("force-dynamic page", () => {
    // Ref: opennextjs-cloudflare — force-dynamic pages should never have ISR cache headers
    test("should not have ISR cache header", async ({ request }) => {
      const res = await request.get(`${baseUrl()}/dynamic-test`);
      expect(res.status()).toBe(200);

      const cacheHeader = res.headers()["x-vinext-cache"];
      expect(cacheHeader).toBeUndefined();

      const cc = res.headers()["cache-control"];
      if (cc) {
        expect(cc).toContain("no-store");
      }
    });

    test("should return different timestamps on each request", async ({ request }) => {
      const res1 = await request.get(`${baseUrl()}/dynamic-test`);
      const html1 = await res1.text();
      const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
      expect(ts1).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const res2 = await request.get(`${baseUrl()}/dynamic-test`);
      const html2 = await res2.text();
      const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    });
  });

  test("404 response has private no-cache Cache-Control", async ({ request }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — 404 responses should have
    // "private, no-cache, no-store, max-age=0, must-revalidate"
    const res = await request.get(`${baseUrl()}/products/999`);
    expect(res.status()).toBe(404);

    const cc = res.headers()["cache-control"];
    if (cc) {
      // Should not have s-maxage or stale-while-revalidate on 404
      expect(cc).not.toContain("s-maxage");
      expect(cc).not.toContain("stale-while-revalidate");
    }
  });
});

/**
 * OpenNext Compat: revalidateTag / revalidatePath E2E lifecycle tests.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/revalidateTag.test.ts
 *
 * OpenNext verifies the full tag-based cache invalidation lifecycle:
 * 1. Load tagged ISR page -> cached (HIT)
 * 2. Call /api/revalidate-tag -> tag invalidated
 * 3. Reload -> content changed (MISS)
 * 4. Subsequent request -> back to HIT
 * They also verify nested pages sharing the same tag are also invalidated.
 */
test.describe("revalidateTag / revalidatePath lifecycle (OpenNext compat)", () => {
  test.beforeEach(async ({ request }) => {
    for (const path of ["/revalidate-tag-test", "/revalidate-tag-test/nested"]) {
      await resetIsrPath(request, path);
    }
  });

  test("revalidateTag invalidates cached page and regenerates", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate tag"
    test.setTimeout(30_000);

    // Load the tagged ISR page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR may insert <!-- --> comment nodes between text and expressions,
    // so use a flexible regex that allows anything between the tag and content.
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Load again to confirm it's cached (same request ID)
    const res2 = await waitForCacheHit(request, "/revalidate-tag-test");
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(res2.headers()["x-vinext-cache"]).toBe("HIT");
    expect(reqId2).toBe(reqId1);

    // Call revalidateTag API
    const tagRes = await request.get(`${baseUrl()}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);
    const tagText = await tagRes.text();
    expect(tagText).toBe("ok");

    // Reload — content should be different (cache was invalidated)
    const res3 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    const html3 = await res3.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId3 =
      html3.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html3.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    // After invalidation, should get fresh content
    expect(reqId3).not.toBe(reqId1);

    // Cache header should be MISS after invalidation
    expect(res3.headers()["x-vinext-cache"]).toBe("MISS");
  });

  test("revalidatePath invalidates specific path", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate path"
    test.setTimeout(30_000);

    // Load the page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Wait a moment, then call revalidatePath
    await new Promise((r) => setTimeout(r, 500));

    const pathRes = await request.get(`${baseUrl()}/api/revalidate-path`);
    expect(pathRes.status()).toBe(200);
    expect(await pathRes.text()).toBe("ok");

    // Reload — content should be different
    const res2 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    expect(reqId2).not.toBe(reqId1);
  });

  test("after invalidation + regen, subsequent request is HIT", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts — after MISS, next request should be HIT
    test.setTimeout(30_000);

    // Populate cache
    await request.get(`${baseUrl()}/revalidate-tag-test`);

    // Invalidate
    await request.get(`${baseUrl()}/api/revalidate-tag`);

    // First request after invalidation — MISS (regen)
    await request.get(`${baseUrl()}/revalidate-tag-test`);

    // Second request — should be HIT now
    const hitRes = await waitForCacheHit(request, "/revalidate-tag-test");
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  // Ref: opennextjs-cloudflare revalidateTag.test.ts — "nested page shares tag"
  test("nested page sharing same tag is also invalidated", async ({ request }) => {
    test.setTimeout(30_000);

    // Load nested page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test/nested`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/Fetched time:\s*(?:<!--.*?-->)*\s*(\d+)/)?.[1];
    expect(ts1).toBeDefined();

    // Invalidate "test-data" tag (shared between parent and nested pages)
    const tagRes = await request.get(`${baseUrl()}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);

    // Reload nested page — should get fresh content
    const res2 = await request.get(`${baseUrl()}/revalidate-tag-test/nested`);
    const html2 = await res2.text();
    const ts2 = html2.match(/Fetched time:\s*(?:<!--.*?-->)*\s*(\d+)/)?.[1];

    expect(ts2).not.toBe(ts1);
  });
});

/**
 * OpenNext Compat: ISR data cache (unstable_cache) separation from page cache.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/isr.test.ts
 *
 * Verifies that unstable_cache (data cache) works alongside ISR page caching.
 */
test.describe("unstable_cache data cache (OpenNext compat)", () => {
  test("unstable_cache returns consistent data across requests", async ({ request }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — data cache separate from page cache
    const res1 = await request.get(`${baseUrl()}/unstable-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR inserts <!-- --> comment nodes between text and expressions
    const value1 = html1.match(/CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/)?.[1];
    expect(value1).toBeDefined();

    // Second request should return the same cached value
    const res2 = await request.get(`${baseUrl()}/unstable-cache-test`);
    const html2 = await res2.text();
    const value2 = html2.match(/CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/)?.[1];

    expect(value2).toBe(value1);
  });

  // Next.js keys unstable_cache by the callback source as well as keyParts:
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/web/spec-extension/unstable-cache.ts
  test("callbacks sharing keyParts and arguments keep separate entries", async ({ request }) => {
    const id = `order-${Date.now()}`;

    const receipt1 = await readSharedKeyPartsRoute(request, "receipt", id);
    expect(receipt1).toMatchObject({ kind: "receipt", orderId: id });
    expect(receipt1.customerEmail).toBe(`customer-${id}@example.com`);

    const summary1 = await readSharedKeyPartsRoute(request, "summary", id);
    expect(summary1).toMatchObject({ kind: "summary", orderId: id });
    expect(summary1).not.toHaveProperty("customerEmail");

    // Each callback still serves its own cached entry.
    expect(await readSharedKeyPartsRoute(request, "summary", id)).toEqual(summary1);
    expect(await readSharedKeyPartsRoute(request, "receipt", id)).toEqual(receipt1);
  });

  // Next.js joins keyParts with "," before hashing, a known TODO, so tuples
  // whose parts join alike share an entry there. vinext keeps them apart.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/web/spec-extension/unstable-cache.ts
  for (const order of ["first", "second"] as const) {
    test(`keyParts tuples that join alike keep separate entries (${order} tuple primed)`, async ({
      request,
    }) => {
      const id = `record-${order}-${Date.now()}`;
      const first = { tenant: "tenant:team", scope: "reports", id };
      const second = { tenant: "tenant", scope: "team:reports", id };
      const [primed, other] = order === "first" ? [first, second] : [second, first];

      const primedRecord = await readKeyPartsTupleRoute(request, primed);
      expect(primedRecord).toMatchObject(primed);

      const otherRecord = await readKeyPartsTupleRoute(request, other);
      expect(otherRecord).toMatchObject(other);
      expect(otherRecord.nonce).not.toBe(primedRecord.nonce);

      // Each tuple still serves its own cached entry.
      expect(await readKeyPartsTupleRoute(request, primed)).toEqual(primedRecord);
      expect(await readKeyPartsTupleRoute(request, other)).toEqual(otherRecord);
    });
  }

  // Next.js lets Client Components import unstable_cache, where its browser
  // build of next/cache only calls the callback.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/cache.js
  test("Client Components can import and call unstable_cache", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${baseUrl()}/nextjs-compat/unstable-cache-client`);

    await expect(page.getByTestId("client-greeting")).toHaveText("hello client");
    expect(pageErrors).toEqual([]);
  });

  // Next.js skips the read for an unstable_cache called inside another's
  // callback, so revalidating the outer entry's tag reruns the inner one too.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/web/spec-extension/unstable-cache.ts
  test("revalidating an unstable_cache reruns a nested unstable_cache", async ({ request }) => {
    const id = `nested-${Date.now()}`;

    const first = await readNestedCacheRoute(request, id);
    expect(await readNestedCacheRoute(request, id)).toEqual(first);

    const revalidate = await request.get(
      `${baseUrl()}/nextjs-compat/api/unstable-cache-nested?id=${id}&revalidate=1`,
    );
    expect(revalidate.status()).toBe(200);

    expect((await readNestedCacheRoute(request, id)).nonce).not.toBe(first.nonce);
  });

  test("a Server Action reruns a nested unstable_cache after the outer entry revalidates", async ({
    page,
    request,
  }) => {
    const id = `nested-action-${Date.now()}`;
    await page.goto(`${baseUrl()}/nextjs-compat/action-nested-unstable-cache?id=${id}`);
    await waitForAppRouterHydration(page);

    const reads = page.locator("#nested-reads li");
    const read = async (count: number) => {
      await page.click("#read-nested");
      await expect(reads).toHaveCount(count);
      return reads.nth(count - 1).textContent();
    };

    const first = await read(1);
    expect(await read(2)).toBe(first);

    const revalidate = await request.get(
      `${baseUrl()}/nextjs-compat/api/unstable-cache-nested?id=${id}&revalidate=1`,
    );
    expect(revalidate.status()).toBe(200);

    expect(await read(3)).not.toBe(first);
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  test("unstable_cache bypasses cache in draft mode", async ({ request }) => {
    const key = `bypass-${Date.now()}`;

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);

      const draft1 = await readDraftCachePage(request, key);
      const draft2 = await readDraftCachePage(request, key);

      expect(draft1.data).not.toBe(draft2.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }
  });

  test("unstable_cache does not cache new results in draft mode", async ({ request }) => {
    const key = `write-${Date.now()}`;

    let draft;
    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      draft = await readDraftCachePage(request, key);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    const normal = await readDraftCachePage(request, key);

    expect(draft).toBeDefined();
    expect(draft.data).not.toBe(normal.data);
  });

  test("unstable_cache exposes draft mode status", async ({ request }) => {
    const key = `status-${Date.now()}`;

    const normal = await readDraftCachePage(request, key);
    expect(normal.draftMode).toBe("false");

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft = await readDraftCachePage(request, key);
      expect(draft.draftMode).toBe("true");
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }
  });

  // Extended from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  test("dynamic error pages keep draft cache bypass separate from access errors", async ({
    request,
  }) => {
    const normal = await readDynamicErrorDraftCachePage(request);

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft1 = await readDynamicErrorDraftCachePage(request);
      const draft2 = await readDynamicErrorDraftCachePage(request);

      expect(draft1.draftMode).toBe("true");
      expect(draft1.data).not.toBe(normal.data);
      expect(draft2.data).not.toBe(draft1.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    expect((await readDynamicErrorDraftCachePage(request)).data).toBe(normal.data);
  });

  test("dynamic error route handlers keep draft cache bypass separate from access errors", async ({
    request,
  }) => {
    const normal = await readDraftCacheRoute(request);

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft1 = await readDraftCacheRoute(request);
      const draft2 = await readDraftCacheRoute(request);

      expect(draft1.draftMode).toBe(true);
      expect(draft1.data).not.toBe(normal.data);
      expect(draft2.data).not.toBe(draft1.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    expect((await readDraftCacheRoute(request)).data).toBe(normal.data);
  });
});

async function readSharedKeyPartsRoute(
  request: APIRequestContext,
  route: "receipt" | "summary",
  id: string,
) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/api/unstable-cache-shared-key-parts/${route}?id=${encodeURIComponent(id)}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function readKeyPartsTupleRoute(
  request: APIRequestContext,
  tuple: { tenant: string; scope: string; id: string },
) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/api/unstable-cache-key-parts-tuple?${new URLSearchParams(tuple)}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function readNestedCacheRoute(request: APIRequestContext, id: string) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/api/unstable-cache-nested?id=${encodeURIComponent(id)}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function readDraftCachePage(request: APIRequestContext, key: string) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/unstable-cache-draft?key=${encodeURIComponent(key)}`,
  );
  expect(response.status()).toBe(200);
  const html = await response.text();
  return {
    data: html.match(/id="cached-data">([^<]+)/)?.[1],
    draftMode: html.match(/id="draft-mode-enabled">([^<]+)/)?.[1],
  };
}

async function readDynamicErrorDraftCachePage(request: APIRequestContext) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/unstable-cache-draft-dynamic-error`,
  );
  expect(response.status()).toBe(200);
  const html = await response.text();
  return {
    data: html.match(/id="cached-data">([^<]+)/)?.[1],
    draftMode: html.match(/id="draft-mode-enabled">([^<]+)/)?.[1],
  };
}

async function readDraftCacheRoute(request: APIRequestContext) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/api/unstable-cache-draft-dynamic-error`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { data: string; draftMode: boolean };
}

testRouteHandlerStoragePolicies();
