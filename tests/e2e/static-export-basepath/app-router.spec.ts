import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4203";

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
