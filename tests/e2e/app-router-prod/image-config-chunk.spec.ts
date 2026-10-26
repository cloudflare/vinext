import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

// next/image's remote-pattern checks use ipaddr.js. It should load only on the
// routes that render next/image, never with the runtime on every route.
const IPADDR_MARKER = "neither IPv6 nor IPv4";

async function loadsIpaddr(page: Page, request: APIRequestContext, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__NEXT_HYDRATED_AT !== undefined);
  const urls = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname.endsWith(".js")),
  );
  const scripts = await Promise.all(urls.map(async (url) => (await request.get(url)).text()));
  return scripts.some((code) => code.includes(IPADDR_MARKER));
}

test("only routes that render next/image load ipaddr.js", async ({ page, request }) => {
  expect(await loadsIpaddr(page, request, "/about")).toBe(false);
  expect(await loadsIpaddr(page, request, "/nextjs-compat/image-blur-placeholder")).toBe(true);
  await expect(page.locator("#transparent-image")).toBeVisible();
});
