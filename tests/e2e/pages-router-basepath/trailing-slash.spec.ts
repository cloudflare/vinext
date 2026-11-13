// Ported from Next.js: test/e2e/basepath/trailing-slash.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/trailing-slash.test.ts

import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4190";

function getRawPath(path: string): Promise<{ body: string; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4190 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          location: Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test.describe("basePath + trailingSlash", () => {
  test("preserves raw spelling while adding a trailing slash", async () => {
    const redirect = await getRawPath("/docs/%68ello");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("/docs/%68ello/");

    const alias = await getRawPath("/docs/%68ello/");
    expect(alias.status).toBe(404);
    expect(alias.body).not.toContain("Hello");
  });

  test("canonicalizes dot segments before basePath and trailing-slash handling", async () => {
    const redirect = await getRawPath("/docs/x/%2e%2e/hello");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("/docs/hello/");

    const page = await getRawPath("/docs/%2e/hello/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hello page");

    const outside = await getRawPath("/docs/%2e%2e/hello/");
    expect(outside.status).toBe(404);
  });

  // "/slashed-guard/" accepts /docs/slashed-guard/ only as requested, slash
  // included. Next.js then retests without the slash and ends the request with
  // an empty 200; vinext runs middleware.
  test("runs middleware for a request only the slashed matcher accepts", async () => {
    const response = await getRawPath("/docs/slashed-guard/");
    expect(response.status).toBe(403);
    expect(response.body).toBe("blocked by middleware");
  });

  // Next.js renders the shared getStaticProps /404 for "/404", keeping only
  // the request's trailing slash under trailingSlash:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
  test("renders the shared /404 document for its own trailing-slash path", async () => {
    const missing = await getRawPath("/docs/missing-share-token/");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain("missing-share-token");
    expect(missing.body).toContain('<p id="as-path">/404/</p>');
  });

  // The /404 page exports getStaticProps and the app has middleware, so the
  // client replaces the current URL after hydration (`_h: 1`). Its 404 response
  // must not hard-navigate to the same URL: Next.js's handleHardNavigation()
  // refuses that, and the reloaded page would repeat it forever.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/router.ts
  test("loads an unknown URL once after the hydration query update", async ({ page }) => {
    const missingPath = "/docs/missing-page/";
    let documentLoads = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") documentLoads++;
    });
    const hydrationUpdate = page.waitForResponse(
      (response) =>
        !response.request().isNavigationRequest() &&
        new URL(response.url()).pathname === missingPath,
    );

    await page.goto(`${BASE}${missingPath}`);
    expect((await hydrationUpdate).status()).toBe(404);
    // A hard navigation scheduled by the update starts within a task.
    await page.waitForTimeout(500);

    expect(documentLoads).toBe(1);
    await expect(page.locator("h1")).toHaveText("404 - Page Not Found");
  });

  // The same-URL guard compares whole hrefs, like Next.js's
  // handleHardNavigation(): a hydration-update redirect that changes only the
  // hash is still followed, as a same-document navigation.
  test("follows a fallback hydration redirect that changes only the hash", async ({ page }) => {
    // A fresh slug per run: once generated, the path redirects on the server.
    const slug = `run-${Date.now()}`;
    const path = `/docs/fallback-hash-redirect/${slug}/`;
    let documentLoads = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") documentLoads++;
    });
    const dataResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/fallback-hash-redirect/${slug}.json`),
    );

    await page.goto(`${BASE}${path}#old`);
    expect((await dataResponse).status()).toBe(200);

    await expect(page).toHaveURL(`${BASE}${path}#new`);
    expect(documentLoads).toBe(1);
  });

  // History moves to the redirect target before its render commits. The guard
  // compares against the document the hydration update started on, so a failed
  // target render still recovers with a hard navigation to the target.
  test("hard-navigates when a hydration redirect target fails to render", async ({ page }) => {
    // A fresh slug per run: once generated, the path redirects on the server.
    const sourcePath = `/docs/fallback-redirect-render-error/run-${Date.now()}/`;
    const targetPath = "/docs/render-error-target/";
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        documents.push(new URL(request.url()).pathname);
      }
    });

    await page.goto(`${BASE}${sourcePath}`);

    await expect.poll(() => documents).toEqual([sourcePath, targetPath]);
    await expect(page.locator("#render-error-target")).toHaveText("render error target");
    await expect(page).toHaveURL(`${BASE}${targetPath}`);
  });

  // A hydration redirect chain that comes back to the hydration document is
  // refused by the same-URL guard. Like Next.js, the refusal schedules no other
  // hard navigation: reloading the middle URL would redirect back here.
  test("stops a hydration redirect chain that returns to its document", async ({ page }) => {
    // A fresh slug per run: once generated, the path redirects on the server.
    const slug = `run-${Date.now()}`;
    const sourcePath = `/docs/fallback-redirect-loop/${slug}/`;
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        documents.push(new URL(request.url()).pathname);
      }
    });
    const middleData = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/redirect-loop-middle/${slug}.json`),
    );

    await page.goto(`${BASE}${sourcePath}`);
    expect((await middleData).status()).toBe(200);
    // A hard navigation scheduled by the update starts within a task.
    await page.waitForTimeout(500);

    expect(documents).toEqual([sourcePath]);
  });

  test("replaces state when same asPath but different url", async ({ page }) => {
    await page.goto(`${BASE}/docs/`);
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });
    await waitForHydration(page);

    // Index -> Hello via #hello-link
    await page.locator("#hello-link").click();
    await expect(page.locator("#something-else-link")).toBeVisible({ timeout: 5_000 });

    // Hello -> (navigate to something-else, displayed as /hello) via #something-else-link
    await page.locator("#something-else-link").click();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });

    // Go back -> should show index
    await page.goBack();
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });

    // Go forward -> should show something-else-page
    await page.goForward();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });
  });

  // Ported from Next.js: test/e2e/gssp-redirect-base-path/gssp-redirect-base-path.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/gssp-redirect-base-path/gssp-redirect-base-path.test.ts
  test("applies basePath and permanent redirect headers to cached gSP redirects", async ({
    request,
  }) => {
    const target = `${BASE}/docs/basepath-redirect/cached/`;
    const first = await request.get(target, { maxRedirects: 0 });
    expect(first.status()).toBe(308);
    expect(first.headers().location).toBe("/docs/hello");
    expect(first.headers().refresh).toBe("0;url=/docs/hello");
    expect(await first.text()).toBe("/docs/hello");

    const cached = await request.get(target, { maxRedirects: 0 });
    expect(cached.status()).toBe(308);
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(cached.headers().location).toBe("/docs/hello");
    expect(cached.headers().refresh).toBe("0;url=/docs/hello");

    const withoutBasePath = await request.get(`${BASE}/docs/basepath-redirect/no-base/`, {
      maxRedirects: 0,
    });
    expect(withoutBasePath.status()).toBe(308);
    expect(withoutBasePath.headers().location).toBe("/hello");
    expect(withoutBasePath.headers().refresh).toBe("0;url=/hello");
  });

  test("normalizes local redirect paths after basePath without changing data or external URLs", async ({
    request,
  }) => {
    const local = await request.get(`${BASE}/docs/basepath-redirect/slashes/`, {
      maxRedirects: 0,
    });
    expect(local.status()).toBe(308);
    expect(local.headers().location).toBe("/docs/hello/world/deep?keep=//query\\value");
    expect(local.headers().refresh).toBe("0;url=/docs/hello/world/deep?keep=//query\\value");

    const homeHtml = await (await request.get(`${BASE}/docs/`)).text();
    const buildId = homeHtml.match(/"buildId":"([^"]+)"/)?.[1];
    expect(buildId).toBeDefined();
    const data = await request.get(
      `${BASE}/docs/_next/data/${buildId}/basepath-redirect/slashes.json`,
    );
    expect(await data.json()).toMatchObject({
      pageProps: {
        __N_REDIRECT: "/hello//world\\deep?keep=//query\\value",
        __N_REDIRECT_STATUS: 308,
      },
    });

    const external = await request.get(`${BASE}/docs/basepath-redirect/external/`, {
      maxRedirects: 0,
    });
    expect(external.headers().location).toBe("https://example.com/a//b\\c?keep=//query\\value");
  });
});
