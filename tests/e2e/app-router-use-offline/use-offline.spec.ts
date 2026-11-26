// Ported from Next.js: test/e2e/app-dir/use-offline/use-offline.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-offline/use-offline.test.ts
//
// Next.js's first case (a prefetched static shell renders while offline) needs
// cachedNavigations; the cases here need only experimental.useOffline. Playwright's
// network emulation fires the browser's own offline/online events and fails every
// request at the network layer.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

function offlineStatus(page: Page) {
  return page.locator(".offline-status").first();
}

async function openHome(page: Page) {
  await page.goto("/");
  await waitForAppRouterHydration(page);
  await expect(page.locator("#home")).toContainText("Home");
  await expect(offlineStatus(page)).toHaveText("online");
}

test.describe("useOffline", () => {
  test("retries a navigation once connectivity is restored, without a document load", async ({
    page,
    context,
  }) => {
    await openHome(page);
    // A document load would drop this marker.
    await page.evaluate(() => {
      (window as unknown as { __softNavMarker: boolean }).__softNavMarker = true;
    });

    // Offline BEFORE revealing the link: no prefetch happens, and both the
    // prefetch and the navigation fetch fail.
    await context.setOffline(true);
    await page.locator('input[data-link-accordion="/destination"]').click();
    await page.locator('a[href="/destination"]').click();

    // The navigation is held, pending; the reader is told why.
    await expect(offlineStatus(page)).toHaveText("offline");
    await expect(page.locator("#destination-content")).toHaveCount(0);
    await expect(page.locator("#home")).toContainText("Home");

    await context.setOffline(false);

    await expect(page.locator("#destination-dynamic")).toHaveText("Dynamic data loaded");
    await expect(offlineStatus(page)).toHaveText("online");
    expect(
      await page.evaluate(
        () => (window as unknown as { __softNavMarker?: boolean }).__softNavMarker,
      ),
    ).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/destination");
  });

  test("updates the offline indicator immediately on disconnect", async ({ page, context }) => {
    await openHome(page);

    // No navigation: the browser's offline event alone flips useOffline().
    await context.setOffline(true);
    await expect(offlineStatus(page)).toHaveText("offline");

    // The online event triggers a connectivity check, which flips it back.
    await context.setOffline(false);
    await expect(offlineStatus(page)).toHaveText("online");
  });

  test("replays a Server Action whose request lost the network", async ({ page, context }) => {
    await page.goto("/action");
    await waitForAppRouterHydration(page);
    await expect(page.locator("#save-result")).toHaveText("none");

    await context.setOffline(true);
    await page.locator("#save").click();
    await expect(offlineStatus(page)).toHaveText("offline");
    await expect(page.locator("#save-pending")).toHaveText("pending");
    await expect(page.locator("#save-result")).toHaveText("none");

    await context.setOffline(false);
    await expect(page.locator("#save-result")).not.toHaveText("none");
    await expect(page.locator("#save-pending")).toHaveText("idle");
    await expect(offlineStatus(page)).toHaveText("online");
  });

  test("holds a prefetch while offline and sends it when the connection returns", async ({
    page,
    context,
  }) => {
    await openHome(page);
    const prefetches: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/destination") && request.method() === "GET") {
        prefetches.push(url.pathname);
      }
    });

    await context.setOffline(true);
    await expect(offlineStatus(page)).toHaveText("offline");
    // The link enters the viewport while offline: nothing is sent.
    await page.locator('input[data-link-accordion="/destination"]').click();
    await page.waitForTimeout(500);
    expect(prefetches).toEqual([]);

    await context.setOffline(false);
    await expect(offlineStatus(page)).toHaveText("online");
    await expect.poll(() => prefetches.length).toBeGreaterThan(0);

    await page.locator('a[href="/destination"]').click();
    await expect(page.locator("#destination-dynamic")).toHaveText("Dynamic data loaded");
  });
});
