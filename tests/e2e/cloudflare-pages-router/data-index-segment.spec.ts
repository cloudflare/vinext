/**
 * A data URL's trailing `index` segment belongs to the page path. Next.js's
 * `denormalizePagePath` rewrites only the root `index` and the encoder's
 * leading `index/` segment, so `/_next/data/<id>/posts/index.json` is the data
 * for `/posts/index` (`posts/[id]` with `id: "index"`), not for `/posts`.
 * Verified against Next.js 16.2.7.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages data URLs with an index segment", () => {
  test("serves the dynamic page addressed by a trailing index segment", async ({
    page,
    request,
  }) => {
    await page.goto(`${BASE}/posts/other`);
    const buildId = await page.evaluate(() => (window as any).__NEXT_DATA__.buildId as string);

    const response = await request.get(`${BASE}/_next/data/${buildId}/posts/index.json`);
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ pageProps: { id: "index" } });
  });

  test("navigates client-side to a dynamic page whose param is index", async ({ page }) => {
    await page.goto(`${BASE}/posts/other`);
    await page.waitForFunction(() => Boolean((window as any).next?.router));
    await page.evaluate(() => ((window as any).__clientNavMarker = true));

    const dataResponse = page.waitForResponse((response) =>
      response.url().includes("/posts/index.json"),
    );
    await page.evaluate(() => (window as any).next.router.push("/posts/index"));
    expect((await dataResponse).status()).toBe(200);

    await expect(page.getByTestId("post-id")).toHaveText("ID: index");
    // A failed data request would fall back to a document navigation.
    expect(await page.evaluate(() => (window as any).__clientNavMarker)).toBe(true);
  });
});
