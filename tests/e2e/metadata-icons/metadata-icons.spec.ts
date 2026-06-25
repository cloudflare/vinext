// Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts

import { expect, test } from "@playwright/test";

const iconInsertionScript = `document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]').forEach(el => document.head.appendChild(el))`;

async function ownedIconPaths(page: import("@playwright/test").Page): Promise<string[]> {
  return page
    .locator("head link[data-vinext-streamed-icon]")
    .evaluateAll((icons) =>
      icons.map((icon) => new URL((icon as HTMLLinkElement).href).pathname).sort(),
    );
}

test.describe("Next.js compat: streamed metadata icons", () => {
  test("relocates initial icons during parsing with the request CSP nonce", async ({ page }) => {
    const response = await page.goto("/heart");
    const html = await response?.text();

    expect(html).toContain(iconInsertionScript);
    expect(html).toMatch(
      /<script nonce="vinext-test-nonce">document\.querySelectorAll\('body link\[rel="icon"\], body link\[rel="apple-touch-icon"\]'\)/,
    );
    await expect(page.locator("body link[data-vinext-streamed-icon]")).toHaveCount(0);
    await expect.poll(() => ownedIconPaths(page)).toEqual(["/heart-apple.png", "/heart.png"]);
  });

  test("replaces icons repeatedly without duplicates and preserves manual head icons", async ({
    page,
  }) => {
    await page.goto("/heart");

    for (let iteration = 0; iteration < 3; iteration++) {
      await page.locator("#metadata-icons-star").click();
      await expect(page).toHaveURL(/\/star$/);
      await expect.poll(() => ownedIconPaths(page)).toEqual(["/star-apple.png", "/star.png"]);

      await page.locator("#metadata-icons-heart").click();
      await expect(page).toHaveURL(/\/heart$/);
      await expect.poll(() => ownedIconPaths(page)).toEqual(["/heart-apple.png", "/heart.png"]);
    }

    await expect(page.locator("head link[data-vinext-streamed-icon]")).toHaveCount(2);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(2);
  });

  test("cleans up owned icons on iconless navigation without deleting manual icons", async ({
    page,
  }) => {
    await page.goto("/heart");
    await expect.poll(() => ownedIconPaths(page)).toHaveLength(2);

    await page.locator("#metadata-icons-none").click();
    await expect(page).toHaveURL(/\/none$/);
    await expect(page.locator("head link[data-vinext-streamed-icon]")).toHaveCount(0);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(2);
  });

  test("keeps rapid icon-to-icon replacement on the latest navigation", async ({ page }) => {
    await page.goto("/heart");

    await page.evaluate(() => {
      document.querySelector<HTMLAnchorElement>("#metadata-icons-star")?.click();
      document.querySelector<HTMLAnchorElement>("#metadata-icons-heart")?.click();
    });

    await expect(page).toHaveURL(/\/heart$/);
    await expect.poll(() => ownedIconPaths(page)).toEqual(["/heart-apple.png", "/heart.png"]);
    await expect(page.locator("head link[data-vinext-streamed-icon]")).toHaveCount(2);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(2);
  });
});
