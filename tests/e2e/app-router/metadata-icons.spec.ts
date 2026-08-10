// Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { waitForAppRouterHydration } from "../helpers";

const iconInsertionScript = `document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]').forEach(el => document.head.appendChild(el))`;

type OwnedIcon = {
  rel: string;
  pathname: string;
  sizes: string | null;
  type: string | null;
  media: string | null;
  color: string | null;
  fetchPriority: string | null;
};

async function ownedIcons(page: Page): Promise<OwnedIcon[]> {
  return page.locator("head link[data-vinext-streamed-icon]").evaluateAll((icons) =>
    icons.map((icon) => ({
      rel: (icon as HTMLLinkElement).rel,
      pathname: new URL((icon as HTMLLinkElement).href).pathname,
      sizes: icon.getAttribute("sizes"),
      type: icon.getAttribute("type"),
      media: icon.getAttribute("media"),
      color: icon.getAttribute("color"),
      fetchPriority: icon.getAttribute("fetchpriority"),
    })),
  );
}

const heartIcons: OwnedIcon[] = [
  {
    rel: "shortcut icon",
    pathname: "/heart-shortcut.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/favicon.ico",
    sizes: "16x16",
    type: "image/x-icon",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/heart.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "apple-touch-icon",
    pathname: "/heart-apple.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "apple-touch-icon-precomposed",
    pathname: "/heart-precomposed.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "mask-icon",
    pathname: "/heart-mask.svg",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
];

const starIcons: OwnedIcon[] = [
  {
    rel: "shortcut icon",
    pathname: "/star-shortcut.png",
    sizes: "48x48",
    type: "image/png",
    media: "screen",
    color: "#654321",
    fetchPriority: "high",
  },
  {
    rel: "icon",
    pathname: "/favicon.ico",
    sizes: "16x16",
    type: "image/x-icon",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star-shared.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star-shared.png",
    sizes: null,
    type: "image/png",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star-duplicate.png",
    sizes: "24x24",
    type: "image/png",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star-duplicate.png",
    sizes: "24x24",
    type: "image/png",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star.png",
    sizes: "16x16",
    type: "image/png",
    media: "(prefers-color-scheme: light)",
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star.png",
    sizes: "32x32",
    type: "image/png",
    media: "(prefers-color-scheme: dark)",
    color: null,
    fetchPriority: null,
  },
  {
    rel: "icon",
    pathname: "/star.png",
    sizes: "any",
    type: "image/svg+xml",
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "apple-touch-icon",
    pathname: "/star-apple.png",
    sizes: null,
    type: null,
    media: "screen",
    color: "#123456",
    fetchPriority: "low",
  },
  {
    rel: "apple-touch-icon-precomposed",
    pathname: "/star-precomposed.png",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
  {
    rel: "mask-icon",
    pathname: "/star-mask.svg",
    sizes: null,
    type: null,
    media: null,
    color: null,
    fetchPriority: null,
  },
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
      /<script nonce="vinext-test-nonce">document\.querySelectorAll\('body link\[rel="icon"\], body link\[rel="apple-touch-icon"\]'/,
    );
    await expect(page.locator("body link[data-vinext-streamed-icon]")).toHaveCount(0);
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    expect(consoleErrors).toEqual([]);
  });

  test("preserves descriptor order before client hydration", async ({ page }) => {
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "script") {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto("/metadata-icons-stream/star", { waitUntil: "domcontentloaded" });

    await expect(page.locator("body link[data-vinext-streamed-icon]")).toHaveCount(0);
    await expect.poll(() => ownedIcons(page)).toEqual(starIcons);
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

  test("preserves same-URL descriptors that differ only by omitted attributes", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/metadata-icons-stream/star");

    await expect
      .poll(() =>
        ownedIcons(page).then((icons) =>
          icons.filter((icon) => icon.pathname === "/star-shared.png"),
        ),
      )
      .toEqual([starIcons[2], starIcons[3]]);
    expect(consoleErrors).toEqual([]);
  });

  test("preserves exact duplicate icon count and order", async ({ page, consoleErrors }) => {
    await page.goto("/metadata-icons-stream/star");

    await expect
      .poll(() =>
        ownedIcons(page).then((icons) =>
          icons.filter((icon) => icon.pathname === "/star-duplicate.png"),
        ),
      )
      .toEqual([starIcons[4], starIcons[5]]);
    expect(consoleErrors).toEqual([]);
  });

  test("supports shortcut icon descriptors", async ({ page, consoleErrors }) => {
    await page.goto("/metadata-icons-stream/star");

    await expect
      .poll(() =>
        ownedIcons(page).then((icons) =>
          icons.filter((icon) => icon.pathname === "/star-shortcut.png"),
        ),
      )
      .toEqual([starIcons[0]]);
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
        {
          rel: "icon",
          pathname: "/icon.png",
          sizes: "1x1",
          type: "image/png",
          media: null,
          color: null,
          fetchPriority: null,
        },
        {
          rel: "icon",
          pathname: "/icon",
          sizes: "32x32",
          type: "image/png",
          media: null,
          color: null,
          fetchPriority: null,
        },
        {
          rel: "icon",
          pathname: "/favicon.ico",
          sizes: "16x16",
          type: "image/x-icon",
          media: null,
          color: null,
          fetchPriority: null,
        },
        {
          rel: "apple-touch-icon",
          pathname: "/apple-icon.png",
          sizes: "1x1",
          type: "image/png",
          media: null,
          color: null,
          fetchPriority: null,
        },
      ]);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });

  test("keeps rapid icon replacement on the latest navigation", async ({ page, consoleErrors }) => {
    await page.goto("/metadata-icons-stream/none");
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      Object.assign(window, { __VINEXT_STAR_RSC_STARTED__: false });
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(rawUrl, window.location.href);
        const response = originalFetch(input, init);
        if (url.pathname === "/metadata-icons-stream/star" && url.searchParams.has("_rsc")) {
          Object.assign(window, { __VINEXT_STAR_RSC_STARTED__: true });
        }
        return response;
      };
    });

    await page.evaluate(() => {
      document.querySelector<HTMLAnchorElement>("#metadata-icons-star")?.click();
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__VINEXT_STAR_RSC_STARTED__")))
      .toBe(true);
    await page.locator("#metadata-icons-heart").click();

    await expect(page).toHaveURL(/\/metadata-icons-stream\/heart$/);
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    await page.waitForTimeout(200);
    await expect.poll(() => ownedIcons(page)).toEqual(heartIcons);
    await expect(page.locator("head link[data-manual-icon]")).toHaveCount(3);
    expect(consoleErrors).toEqual([]);
  });
});
