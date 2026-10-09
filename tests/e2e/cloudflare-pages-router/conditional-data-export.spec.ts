import { expect, test } from "@playwright/test";

const BASE = process.env.CLOUDFLARE_PAGES_ROUTER_BASE_URL ?? "http://localhost:4177";
const PAGE = "/conditional-data-export";
// Must match examples/pages-router-cloudflare/lib/private-page-config.ts.
const SIGNING_KEY = "VINEXT_CONDITIONAL_GSSP_SIGNING_KEY_5e1c84b2";

/**
 * Follow every JavaScript URL reachable from the page's HTML, the way an
 * anonymous visitor can: script tags, static imports, dynamic imports and
 * Vite's preload dependency lists.
 */
async function crawlPublicJavaScript(
  request: import("@playwright/test").APIRequestContext,
  html: string,
): Promise<Map<string, string>> {
  const queue = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(
    (match) => new URL(match[1], BASE).href,
  );
  const sources = new Map<string, string>();
  while (queue.length > 0) {
    const url = queue.shift()!;
    if (sources.has(url)) continue;
    sources.set(url, "");
    const response = await request.get(url);
    // String literals shaped like script paths (e.g. middleware matcher
    // sources) are not all chunks; only JavaScript responses are crawled.
    if (!response.ok() || !response.headers()["content-type"]?.includes("javascript")) continue;
    const source = await response.text();
    sources.set(url, source);
    for (const [, specifier] of source.matchAll(
      /["'`]((?:\.{1,2}\/|\/?_next\/)[^"'`]+\.js)["'`]/g,
    )) {
      const next = specifier.startsWith(".")
        ? new URL(specifier, url).href
        : new URL(specifier.replace(/^\/?/, "/"), BASE).href;
      if (!sources.has(next)) queue.push(next);
    }
  }
  return sources;
}

test.describe("Pages Router conditional data export on Cloudflare Workers", () => {
  test("runs the conditionally assigned getServerSideProps on the server", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(BASE + PAGE);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("key-length")).toHaveText(String(SIGNING_KEY.length));
    // The client module must not execute the stripped assignment.
    await expect(page.getByTestId("hydrated")).toHaveText("yes");
    expect(pageErrors).toEqual([]);
  });

  test("keeps the data export's server-only imports out of public JavaScript", async ({
    request,
  }) => {
    const response = await request.get(BASE + PAGE);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(SIGNING_KEY);

    const sources = await crawlPublicJavaScript(request, html);
    // Guard against a crawl that silently stops before the page's own chunk.
    expect([...sources.keys()].some((url) => url.includes("conditional-data-export"))).toBe(true);
    for (const [url, source] of sources) {
      expect(source, url).not.toContain(SIGNING_KEY);
      expect(source, url).not.toContain("getServerSideProps");
    }
  });
});
