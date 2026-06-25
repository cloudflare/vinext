// Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

const iconInsertionScript = `document.querySelectorAll('body link[data-vinext-streamed-icon]').forEach(el => document.head.appendChild(el))`;

type OwnedIcon = { rel: string; pathname: string };

async function ownedIcons(page: Page): Promise<OwnedIcon[]> {
  return page.locator("head link[data-vinext-streamed-icon]").evaluateAll((icons) =>
    icons
      .map((icon) => ({
        rel: (icon as HTMLLinkElement).rel,
        pathname: new URL((icon as HTMLLinkElement).href).pathname,
      }))
      .sort((left, right) => left.rel.localeCompare(right.rel)),
  );
}

const heartIcons: OwnedIcon[] = [
  { rel: "apple-touch-icon", pathname: "/heart-apple.png" },
  { rel: "apple-touch-icon-precomposed", pathname: "/heart-precomposed.png" },
  { rel: "icon", pathname: "/favicon.ico" },
  { rel: "icon", pathname: "/heart.png" },
  { rel: "mask-icon", pathname: "/heart-mask.svg" },
  { rel: "shortcut icon", pathname: "/heart-shortcut.png" },
];

const starIcons: OwnedIcon[] = [
  { rel: "apple-touch-icon", pathname: "/star-apple.png" },
  { rel: "apple-touch-icon-precomposed", pathname: "/star-precomposed.png" },
  { rel: "icon", pathname: "/favicon.ico" },
  { rel: "icon", pathname: "/star.png" },
  { rel: "mask-icon", pathname: "/star-mask.svg" },
  { rel: "shortcut icon", pathname: "/star-shortcut.png" },
];

test.describe("Next.js compat: streamed metadata icons", () => {
  test("relocates every metadata icon relation with the request CSP nonce", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto("/metadata-icons-stream/heart");
    const html = await response?.text();

    expect(response?.headers()["content-security-policy"]).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );
    expect(html).toContain(iconInsertionScript);
    expect(html).toMatch(
      /<script nonce="vinext-test-nonce">document\.querySelectorAll\('body link\[data-vinext-streamed-icon\]'/,
    );
    await expect(page.locator("body link[data-vinext-streamed-icon]")).toHaveCount(0);
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    expect(consoleErrors).toEqual([]);
  });

  test("replaces all icon relations repeatedly and preserves manual links", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/metadata-icons-stream/heart");

    for (let iteration = 0; iteration < 3; iteration++) {
      await page.locator("#metadata-icons-star").click();
      await expect(page).toHaveURL(/\/metadata-icons-stream\/star$/);
      await expect.poll(() => ownedIcons(page)).toEqual(starIcons);

      await page.locator("#metadata-icons-heart").click();
      await expect(page).toHaveURL(/\/metadata-icons-stream\/heart$/);
      await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    }

    await expect(page.locator("head link[data-vinext-streamed-icon]")).toHaveCount(6);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });

  test("cleans up every owned relation on iconless navigation", async ({ page, consoleErrors }) => {
    await page.goto("/metadata-icons-stream/heart");
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);

    await page.locator("#metadata-icons-none").click();
    await expect(page).toHaveURL(/\/metadata-icons-stream\/none$/);
    await expect
      .poll(() => ownedIcons(page))
      .toEqual([
        { rel: "apple-touch-icon", pathname: "/apple-icon.png" },
        { rel: "icon", pathname: "/icon.png" },
        { rel: "icon", pathname: "/icon" },
        { rel: "icon", pathname: "/favicon.ico" },
      ]);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });

  test("keeps rapid icon replacement on the latest navigation", async ({ page, consoleErrors }) => {
    await page.goto("/metadata-icons-stream/heart");

    await page.evaluate(() => {
      document.querySelector<HTMLAnchorElement>("#metadata-icons-star")?.click();
      document.querySelector<HTMLAnchorElement>("#metadata-icons-heart")?.click();
    });

    await expect(page).toHaveURL(/\/metadata-icons-stream\/heart$/);
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });
});
