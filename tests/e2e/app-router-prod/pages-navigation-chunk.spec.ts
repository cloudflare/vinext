import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

// A string literal that ships only with the App Router navigation runtime's
// chunk (from its navigation planner). Like Next.js, Pages Router pages in a
// hybrid app, including those that use next/navigation's hooks, never load it.
const APP_ROUTER_MARKER = "Unknown requested navigation work";

async function loadsAppRouterRuntime(page: Page, request: APIRequestContext, path: string) {
  await page.goto(path);
  await page.waitForFunction(
    () => (window as any).__NEXT_HYDRATED === true || (window as any).__NEXT_HYDRATED_AT,
  );
  const urls = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname.endsWith(".js")),
  );
  const scripts = await Promise.all(urls.map(async (url) => (await request.get(url)).text()));
  return scripts.some((code) => code.includes(APP_ROUTER_MARKER));
}

test("only App Router routes load the App Router runtime", async ({ page, request }) => {
  expect(await loadsAppRouterRuntime(page, request, "/old-school")).toBe(false);
  expect(await loadsAppRouterRuntime(page, request, "/pages-dir-use-params/hello")).toBe(false);
  await expect(page.locator("#params")).toHaveText('"hello"');
  expect(await loadsAppRouterRuntime(page, request, "/about")).toBe(true);
});
