// Ported from Next.js: test/e2e/app-dir/use-offline/use-offline.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-offline/use-offline.test.ts
//
// Next.js's first case (a prefetched static shell renders offline) needs
// cachedNavigations, so it is not ported. Playwright's setOffline fires the
// browser's offline/online events and fails every request at the network layer.
import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

async function open(page: Page, path: string) {
  await page.goto(path);
  await waitForAppRouterHydration(page);
  await expect(page.locator(".offline-status")).toHaveText("online");
}

test("useOffline() follows the browser's offline and online events", async ({ page, context }) => {
  await open(page, "/");

  await context.setOffline(true);
  await expect(page.locator(".offline-status")).toHaveText("offline");

  await context.setOffline(false);
  await expect(page.locator(".offline-status")).toHaveText("online");
});

test("a navigation that loses the network completes once it returns, without a document load", async ({
  page,
  context,
}) => {
  await open(page, "/");
  // A document load would drop this marker.
  await page.evaluate(() => Reflect.set(window, "__softNavMarker", true));

  await context.setOffline(true);
  await page.getByRole("link", { name: "Destination page" }).click();
  await expect(page.locator(".offline-status")).toHaveText("offline");
  await expect(page.locator("#home")).toBeVisible();

  await context.setOffline(false);
  await expect(page.locator("#destination")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/destination");
  expect(await page.evaluate(() => Reflect.get(window, "__softNavMarker"))).toBe(true);
});

test("a Server Action that loses the network runs once it returns", async ({ page, context }) => {
  await open(page, "/action");

  await context.setOffline(true);
  await page.locator("#save").click();
  await expect(page.locator(".offline-status")).toHaveText("offline");
  await expect(page.locator("#save-pending")).toHaveText("pending");

  await context.setOffline(false);
  await expect(page.locator("#save-result")).not.toHaveText("none");
  await expect(page.locator("#save-pending")).toHaveText("idle");
});
