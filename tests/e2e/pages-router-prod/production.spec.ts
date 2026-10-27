import { testPagesStoragePolicies } from "../pages-storage-policy";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { waitForHydration } from "../helpers";

/**
 * Production build E2E tests for Pages Router.
 *
 * These tests run against `vite build` + `vinext start` output,
 * NOT the dev server. The production server is started on port 4175
 * via the webServer config in playwright.config.ts.
 */
const BASE = "http://localhost:4175";

test("staged middleware cookies appear once in production HTML and data", async ({
  baseURL,
  request,
}) => {
  const base = baseURL ?? BASE;
  const html = await request.get(`${base}/rewrite-with-cookie`);
  expect(html.status()).toBe(200);
  const content = await html.text();
  const data = JSON.parse(
    content.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1],
  );
  const json = await request.get(`${base}/_next/data/${data.buildId}/rewrite-with-cookie.json`);
  expect(json.status()).toBe(200);
  for (const response of [html, json]) {
    const cookies = response
      .headersArray()
      .filter(
        ({ name, value }) =>
          name.toLowerCase() === "set-cookie" && value.startsWith("rewrite-cookie="),
      );
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe("rewrite-cookie=visible; Path=/");
  }
});

// Next.js router-server.ts answers a middleware app's data miss with a JSON
// 404 naming the requested path, so the client router hard-navigates.
test("answers a middleware app's data miss with a JSON 404", async ({ baseURL, request }) => {
  const base = baseURL ?? BASE;
  const html = await (await request.get(`${base}/rewrite-with-cookie`)).text();
  const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();

  const response = await request.get(`${base}/_next/data/${buildId}/totally-missing-page.json`, {
    headers: { "x-nextjs-data": "1" },
  });
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["x-nextjs-matched-path"]).toBe("/totally-missing-page");
  expect(response.headers()["cache-control"]).toBe(
    "private, no-cache, no-store, max-age=0, must-revalidate",
  );
  expect(await response.json()).toEqual({});
});

test.describe("Pages Router Production Build", () => {
  test("index page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    await expect(page.locator("body")).toContainText("This is a Pages Router app running on Vite.");
  });

  test("about page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/about`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("initial HTML preloads every script the page loads to hydrate", async ({ page }) => {
    // Next.js emits the scripts of `_app` and the page in the document, so the
    // browser fetches them in parallel with the client entry instead of after it.
    const response = await page.goto(`${BASE}/about`);
    const html = await response!.text();
    await page.waitForFunction(() => (window as any).__NEXT_HYDRATED === true);
    const preloaded = new Set(
      (html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/g) ?? []).map(
        (tag) => new URL(tag.match(/\bhref="([^"]+)"/)![1], BASE).pathname,
      ),
    );
    const { appModuleUrl, pageModuleUrl } = await page.evaluate(
      () => (window as any).__NEXT_DATA__.__vinext,
    );
    expect(preloaded).toContain(appModuleUrl);
    expect(preloaded).toContain(pageModuleUrl);

    const loadedBeforeHydration = await page.evaluate(() => {
      const hydratedAt = (window as any).__NEXT_HYDRATED_AT as number;
      return performance
        .getEntriesByType("resource")
        .filter((entry) => entry.startTime <= hydratedAt)
        .map((entry) => new URL(entry.name).pathname)
        .filter((pathname) => pathname.endsWith(".js"));
    });
    expect(loadedBeforeHydration.length).toBeGreaterThan(0);
    expect(loadedBeforeHydration.filter((pathname) => !preloaded.has(pathname))).toEqual([]);
  });

  test("pages load next/dynamic and next/form only where they use them", async ({
    page,
    request,
  }) => {
    // String literals that ship only with the next/dynamic and next/form shims.
    const dynamicMarker = "DynamicClientSSRFalse";
    const formMarker = "application/x-www-form-urlencoded";
    const loadedScripts = async (path: string): Promise<string[]> => {
      await page.goto(`${BASE}${path}`);
      await page.waitForFunction(() => (window as any).__NEXT_HYDRATED === true);
      const urls = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => new URL(name).pathname.endsWith(".js")),
      );
      return Promise.all(urls.map(async (url) => (await request.get(url)).text()));
    };

    const aboutScripts = await loadedScripts("/about");
    expect(aboutScripts.length).toBeGreaterThan(0);
    expect(aboutScripts.some((code) => code.includes(dynamicMarker))).toBe(false);
    expect(aboutScripts.some((code) => code.includes(formMarker))).toBe(false);

    expect(
      (await loadedScripts("/dynamic-page")).some((code) => code.includes(dynamicMarker)),
    ).toBe(true);
    expect((await loadedScripts("/form-test")).some((code) => code.includes(formMarker))).toBe(
      true,
    );
  });

  test("only pages that use next/navigation load the App Router runtime", async ({
    page,
    request,
  }) => {
    // A string literal that ships only with the App Router navigation runtime.
    const appRouterMarker = "Unknown requested navigation work";
    const loadsAppRouterRuntime = async (path: string): Promise<boolean> => {
      await page.goto(`${BASE}${path}`);
      await page.waitForFunction(() => (window as any).__NEXT_HYDRATED === true);
      const urls = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => new URL(name).pathname.endsWith(".js")),
      );
      const scripts = await Promise.all(urls.map(async (url) => (await request.get(url)).text()));
      return scripts.some((code) => code.includes(appRouterMarker));
    };

    expect(await loadsAppRouterRuntime("/about")).toBe(false);
    expect(await loadsAppRouterRuntime("/nav-compat/hello?q=1")).toBe(true);
    await expect(page.locator("#use-params")).toHaveText('{"slug":"hello"}');
  });

  test("SSR page renders with getServerSideProps data", async ({ page }) => {
    const response = await page.goto(`${BASE}/ssr`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );
  });

  test("__NEXT_DATA__ is present with page props", async ({ page }) => {
    await page.goto(`${BASE}/ssr`);
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData).toBeDefined();
    expect(nextData.props.pageProps).toBeDefined();
    expect(nextData.props.pageProps.message).toBe("Hello from getServerSideProps");
  });

  test("omits gssp from __NEXT_DATA__ for non-GSSP pages", async ({ page }) => {
    // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/getserversideprops/test/index.test.ts
    await page.goto(`${BASE}/about`);
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect("gssp" in nextData).toBe(false);
  });

  for (const href of ["/gssp-not-found?hiding=true", "/gssp-not-found/first?hiding=true"]) {
    test(`renders the 404 page on GSSP client navigation to ${href}`, async ({ page }) => {
      // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
      // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/getserversideprops/test/index.test.ts
      await page.goto(`${BASE}/`);
      await waitForHydration(page);
      await page.evaluate((target) => (window as any).next.router.push(target), href);
      await expect(page.getByTestId("error-title")).toBeVisible();
      expect(page.url()).toContain(href);
    });
  }

  test("preserves requested dynamic route state while rendering GSSP notFound", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    await page.evaluate(() =>
      (window as any).next.router.push("/gssp-not-found/first?hiding=true"),
    );
    await expect(page.getByTestId("error-title")).toBeVisible();

    const state = await page.evaluate(() => ({
      pathname: (window as any).next.router.pathname,
      route: (window as any).next.router.route,
      query: (window as any).next.router.query,
      asPath: (window as any).next.router.asPath,
      nextDataPage: (window as any).__NEXT_DATA__.page,
    }));
    expect(state).toEqual({
      pathname: "/gssp-not-found/[slug]",
      route: "/gssp-not-found/[slug]",
      query: { hiding: "true", slug: "first" },
      asPath: "/gssp-not-found/first?hiding=true",
      nextDataPage: "/gssp-not-found/[slug]",
    });
  });

  test("API route returns JSON", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const data = await response.json();
    expect(data).toEqual({ message: "Hello from API!" });
  });

  test("discovers getStaticPaths after request-time instrumentation", async ({ request }) => {
    const { prerenderSecret } = JSON.parse(
      fs.readFileSync("tests/fixtures/pages-basic/dist/server/vinext-server.json", "utf8"),
    ) as { prerenderSecret: string };
    const response = await request.get(
      `${BASE}/__vinext/prerender/pages-static-paths?pattern=%2Fblog%2F%3Aslug&locales=%5B%5D&defaultLocale=`,
      { headers: { "x-vinext-prerender-secret": prerenderSecret } },
    );

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      paths: [{ params: { slug: "hello-world" } }, { params: { slug: "getting-started" } }],
      fallback: false,
    });
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent`);
    expect(response?.status()).toBe(404);
  });

  test("dynamic route renders with params", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/hello-world`);
    expect(response?.status()).toBe(200);
    const content = await page.textContent("body");
    expect(content).toContain("hello-world");
  });

  // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/middleware-rewrites/test/index.test.ts
  test("window.next.router.sdc retains prefetched SSG data", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await page.evaluate(async () => {
      const w = window as unknown as {
        next: { router: { prefetch: (url: string) => Promise<void> } };
      };
      await w.next.router.prefetch("/blog/hello-world");
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as {
            next: { router: { sdc: Record<string, Promise<Response>> } };
          };
          return Object.keys(w.next.router.sdc).filter((key) =>
            key.includes("/blog/hello-world.json"),
          ).length;
        }),
      )
      .toBe(1);
  });

  test("navigates to a seeded optional catch-all root", async ({ page }) => {
    // Ported from Next.js: test/e2e/prerender.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/prerender.test.ts
    await page.goto(`${BASE}/`);
    await page.evaluate(() => {
      (window as typeof window & { didTransition?: number }).didTransition = 1;
    });

    await page.locator("#optional-root").click();

    await expect(page.locator("#home")).toBeVisible();
    await expect(page.locator("#catchall")).toHaveText("Catch all: []");
    expect(
      await page.evaluate(
        () => (window as typeof window & { didTransition?: number }).didTransition,
      ),
    ).toBe(1);
  });

  test("import.meta.url uses source file URLs on the server and browser", async ({
    page,
    request,
  }) => {
    // Ported from Next.js: test/e2e/import-meta/import-meta.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/import-meta/import-meta.test.ts
    const response = await request.get(`${BASE}/import-meta`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const match = html.match(/<div id="test-data">([^<]*)<\/div>/);
    expect(match).not.toBeNull();

    const serverData = JSON.parse(decodeHtmlText(match![1])) as { url: string };
    expect(serverData.url).toMatch(/^file:\/\/\//);
    expect(serverData.url).toMatch(/\/pages\/import-meta\.tsx$/);
    expect(serverData.url).not.toContain("/dist/server/entry.js");

    await page.goto(`${BASE}/import-meta`, { waitUntil: "networkidle" });
    await expect(page.locator("#test-data")).toHaveText(
      JSON.stringify({ url: "file:///ROOT/pages/import-meta.tsx" }),
    );
  });

  test("static asset directory serves JS files", async ({ request }) => {
    // The production build outputs client bundles to dist/client/_next/static/
    // (Next.js's canonical layout). Verify asset URLs emitted into HTML are
    // served correctly by the production static handler.
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    // Check the emitted client entry is served correctly.
    const jsMatch = html.match(/src="(\/_next\/static\/[^"]+\.js)"/);
    expect(jsMatch).not.toBeNull();
    const jsPath = jsMatch?.[1];
    if (!jsPath) throw new Error("Expected production HTML to include a client JS asset");

    const jsRes = await request.get(`${BASE}${jsPath}`);
    expect(jsRes.status()).toBe(200);
    expect(jsRes.headers()["content-type"]).toContain("javascript");
    expect(jsRes.headers()["cache-control"]).toContain("immutable");

    const unsupported = await request.post(`${BASE}${jsPath}`);
    expect(unsupported.status()).toBe(405);
    expect(unsupported.headers()["allow"]).toBe("GET, HEAD");

    const unsupportedConditional = await request.post(`${BASE}${jsPath}`, {
      headers: { "If-None-Match": jsRes.headers()["etag"] ?? "*" },
    });
    expect(unsupportedConditional.status()).toBe(405);
    expect(unsupportedConditional.headers()["allow"]).toBe("GET, HEAD");
  });

  test("large responses include compression headers", async ({ request }) => {
    // Production server only compresses responses >= 1024 bytes.
    // Use the SSR page which includes __NEXT_DATA__ with server props,
    // making it more likely to exceed the compression threshold.
    const response = await request.get(`${BASE}/ssr`, {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(response.status()).toBe(200);
    const body = await response.text();
    const encoding = response.headers()["content-encoding"];
    if (body.length >= 1024) {
      // If response is large enough, compression should be applied
      expect(encoding).toBeDefined();
      expect(["br", "gzip", "deflate"]).toContain(encoding);
    }
    // Small responses skip compression — that's expected behavior
  });

  test("_app.tsx wrapper is applied", async ({ page }) => {
    await page.goto(`${BASE}/`);
    // The _app.tsx in pages-basic wraps pages with an app-wrapper div
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();
    await expect(page.locator('[data-testid="global-nav"]')).toBeVisible();
  });

  test("custom _document.tsx shell is used", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const html = await page.content();
    // _document.tsx provides the HTML shell with charset and viewport
    expect(html).toContain("utf-8");
    expect(html).toContain("viewport");
  });
});

function decodeHtmlText(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

testPagesStoragePolicies(BASE);
