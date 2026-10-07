import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";
import type { NavigationRuntime } from "../../../packages/vinext/src/client/navigation-runtime";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4203";

// Same-URL Link navigation must retain the document URL:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
// Regression for https://github.com/cloudflare/vinext/issues/3416.
for (const arrival of ["document", "prefetch"] as const) {
  test(`cached and same-URL navigation after ${arrival} arrival never opens Flight text`, async ({
    page,
  }) => {
    const documentPaths: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") {
        documentPaths.push(new URL(request.url()).pathname);
      }
    });
    const initialPath = arrival === "document" ? "/docs/about" : "/docs";
    const prefetched =
      arrival === "prefetch"
        ? page.waitForResponse((response) => new URL(response.url()).pathname === "/docs/about.txt")
        : null;
    await page.goto(`${BASE}${initialPath}`);
    await waitForAppRouterHydration(page);
    if (prefetched) await (await prefetched).finished();

    // Await the actual navigation completion, including cache publication, so
    // the next click deterministically exercises the visited-response path.
    await page.evaluate(() => {
      const runtime = Reflect.get(
        window,
        Symbol.for("vinext.navigationRuntime"),
      ) as NavigationRuntime;
      const navigate = runtime.functions.navigate!;
      Reflect.set(window, "__completedNavigations", 0);
      runtime.functions.navigate = async (...args) => {
        await navigate(...args);
        Reflect.set(
          window,
          "__completedNavigations",
          Reflect.get(window, "__completedNavigations") + 1,
        );
      };
    });

    const paths =
      arrival === "document"
        ? ["/docs", "/docs/about", "/docs/about", "/docs/about"]
        : ["/docs/about", "/docs", "/docs/about", "/docs/about"];
    for (const [index, pathname] of paths.entries()) {
      const click = index + 1;
      await page.locator(`a[href="${pathname}"]`).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "__completedNavigations")))
        .toBe(click);
      await expect(page).toHaveURL(`${BASE}${pathname}`);
      await expect(
        page.getByRole("heading", {
          name: pathname === "/docs" ? "BasePath Home" : "BasePath About",
        }),
      ).toBeVisible();
      expect(documentPaths).toEqual([initialPath]);
    }
  });
}

test("basePath root soft navigation uses index.txt without trailingSlash", async ({ page }) => {
  const documentPaths: string[] = [];
  const flightPaths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.resourceType() === "document") documentPaths.push(pathname);
    if (pathname.endsWith(".txt")) flightPaths.push(pathname);
  });

  await page.goto(`${BASE}/docs/about`);
  await waitForAppRouterHydration(page);
  await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
  await page.locator('a[href="/docs"]').click();
  await page.waitForURL(`${BASE}/docs`);
  await expect(page.getByRole("heading", { name: "BasePath Home" })).toBeVisible();

  expect(flightPaths).toContain("/docs/index.txt");
  expect(flightPaths).not.toContain("/docs.txt");
  expect(documentPaths).toEqual(["/docs/about"]);
  expect(await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation"))).toBe(true);
});

test("serves static metadata and the rendered 404 under basePath", async ({ request }) => {
  const robots = await request.get(`${BASE}/docs/robots.txt`);
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /docs/private");

  const missing = await request.get(`${BASE}/docs/missing`);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("BasePath Not Found");
});

// Next.js serves public files through the configured basePath and rejects the
// unprefixed URL:
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/basepath.test.ts
test("namespaces public files under basePath", async ({ request }) => {
  const publicFile = await request.get(`${BASE}/docs/public-data.txt`);
  expect(publicFile.status()).toBe(200);
  expect(await publicFile.text()).toBe("basePath public data\n");

  const unprefixed = await request.get(`${BASE}/public-data.txt`);
  expect(unprefixed.status()).toBe(404);
});
