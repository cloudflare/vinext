import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

/**
 * Static export E2E tests for the App Router.
 *
 * These tests run against a `vinext build` output served as static files.
 * The static export fixture uses `output: "export"` in next.config.mjs,
 * so no server-side rendering is involved — all pages are pre-rendered
 * HTML files served by a lightweight HTTP server on port 4180.
 */
const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4180";

test.describe("Static Export — App Router", () => {
  test("home page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Static Export — App Router");
    await expect(page.locator("body")).toContainText(
      "This page is pre-rendered at build time by the App Router.",
    );
  });

  test("about page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/about/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("body")).toContainText(
      "A static App Router page with no dynamic data.",
    );
  });

  test("blog/hello-world renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/hello-world/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: hello-world");
  });

  test("blog/getting-started renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/getting-started/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: getting-started");
  });

  test("blog/advanced-guide renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/advanced-guide/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: advanced-guide");
  });

  test("blog page includes dynamic metadata in title", async ({ page }) => {
    await page.goto(`${BASE}/blog/hello-world/`);
    await expect(page).toHaveTitle("Blog: hello-world");
  });

  test("home page navigation links are present", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const nav = page.locator("nav");
    await expect(nav.locator('a[href="/about/"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/hello-world/"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/getting-started/"]')).toBeVisible();
    await expect(nav.locator('a[href="/old-school/"]')).toBeVisible();
    await expect(nav.locator('a[href="/products/widget/"]')).toBeVisible();
    await expect(nav.locator('a[href="/missing-static-artifact/"]')).toBeVisible();
  });

  test("soft navigation fetches the exported Flight text without a document reload", async ({
    page,
  }) => {
    const documentPaths: string[] = [];
    const flightPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.resourceType() === "document") documentPaths.push(pathname);
      if (pathname.endsWith(".txt") && request.headers().rsc === "1") {
        flightPaths.push(pathname);
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/about/"]').click();
    await page.waitForURL(`${BASE}/about/`);
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page).toHaveTitle("About — Static Export");
    expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(
      true,
    );
    expect(flightPaths).toContain("/about/index.txt");
    expect(documentPaths).toEqual(["/"]);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/static-export-skew-trailing-slash/static-export-skew-trailing-slash.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-export-skew-trailing-slash/static-export-skew-trailing-slash.test.ts
  test("deployment-skewed Flight falls back to the canonical static document", async ({ page }) => {
    const documentPaths: string[] = [];
    const flightPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.resourceType() === "document") documentPaths.push(pathname);
      if (pathname.endsWith(".txt")) flightPaths.push(pathname);
    });
    await page.route("**/about/index.txt", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const skewedBody = body.replace(
        /"deploymentVersion":"[^"]*"/,
        '"deploymentVersion":"foreign-build-id"',
      );
      expect(skewedBody).not.toBe(body);
      await route.fulfill({ response, body: skewedBody });
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/about/"]').click();
    await page.waitForURL(`${BASE}/about/`);
    await expect(page.locator("h1")).toHaveText("About");

    expect(flightPaths).toContain("/about/index.txt");
    expect(documentPaths).toEqual(["/", "/about/"]);
    expect(
      await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation")),
    ).toBeUndefined();
  });

  test("soft navigation restores dynamic useParams from the route manifest", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/blog/hello-world/"]').click();
    await page.waitForURL(`${BASE}/blog/hello-world/`);
    await expect(page.getByTestId("client-slug")).toHaveText("Client slug: hello-world");
    await expect(page).toHaveTitle("Blog: hello-world");
    expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(
      true,
    );
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
  test("useSearchParams reads the browser query after hydration", async ({ page }) => {
    let rscRequests = 0;
    page.on("request", (request) => {
      if (request.headers().rsc === "1") rscRequests++;
    });
    const response = await page.goto(`${BASE}/search-params/?value=expected`);
    expect(response?.status()).toBe(200);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("query-value")).toHaveText("expected");
    expect(page.url()).toBe(`${BASE}/search-params/?value=expected`);
    expect(rscRequests).toBe(0);
  });

  test("useSearchParams reads the query after static-host soft navigation", async ({ page }) => {
    const documentPaths: string[] = [];
    const flightPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.resourceType() === "document") documentPaths.push(pathname);
      if (pathname.endsWith(".txt")) flightPaths.push(pathname);
    });
    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/search-params/?value=navigated"]').click();
    await page.waitForURL(`${BASE}/search-params/?value=navigated`);
    await expect(page.getByTestId("query-value")).toHaveText("navigated");
    expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(
      true,
    );
    expect(flightPaths).toContain("/search-params/index.txt");
    expect(documentPaths).toEqual(["/"]);
  });

  test("back and forward retain the client document", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/about/"]').click();
    await page.waitForURL(`${BASE}/about/`);

    await page.goBack();
    await page.waitForURL(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Static Export — App Router");
    expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(
      true,
    );

    await page.goForward();
    await page.waitForURL(`${BASE}/about/`);
    await expect(page.locator("h1")).toHaveText("About");
    expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(
      true,
    );
  });

  test("missing Flight artifacts fall back to the static 404 document", async ({ page }) => {
    const documentPaths: string[] = [];
    const flightPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.resourceType() === "document") documentPaths.push(pathname);
      if (pathname.endsWith(".txt")) flightPaths.push(pathname);
    });
    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/missing-static-artifact/"]').click();
    await page.waitForURL(`${BASE}/missing-static-artifact/`);

    expect(flightPaths).toContain("/missing-static-artifact/index.txt");
    expect(documentPaths).toContain("/missing-static-artifact/");
    expect(
      await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation")),
    ).toBeUndefined();
  });

  test("root layout metadata is applied", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Static Export Fixture");
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page/`);
    expect(response?.status()).toBe(404);
  });
});
