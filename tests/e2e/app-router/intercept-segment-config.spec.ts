// Next.js renders an interception as its own route, whose loader tree holds
// the owner's layouts and the intercepting page, never the source's page. Its
// segment config comes from those modules alone. Observed in Next.js 16.2.7
// with Turbopack and webpack.

import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROOT = `${BASE}/nextjs-compat/intercept-segment-config`;

async function openWithCookie(page: Page, path: string) {
  await page.context().addCookies([{ name: "intercept-config", value: "v", url: BASE }]);
  await page.goto(`${ROOT}/${path}`);
  await waitForAppRouterHydration(page);
}

test.describe("intercept segment config", () => {
  for (const area of ["owner-error", "owner-static"]) {
    test(`ignores a ${area} owner page's dynamic config`, async ({ page }) => {
      await openWithCookie(page, area);

      await page.click("#intercept-config-link");

      await expect(page.locator("#intercept-config-intercepted")).toHaveText(
        `${area} intercept 1 cookie=v`,
      );
      await expect(page).toHaveURL(`${ROOT}/${area}/1`);
    });
  }

  test("ignores the owner page's dynamic config from a deeper source", async ({ page }) => {
    await openWithCookie(page, "owner-error/1");
    await expect(page.locator("#intercept-config-full")).toHaveText("owner-error full 1");

    await page.click("#intercept-config-next");

    await expect(page.locator("#intercept-config-intercepted")).toHaveText(
      "owner-error intercept 2 cookie=v",
    );
  });

  test("applies the intercepting page's force-static config", async ({ page }) => {
    await openWithCookie(page, "intercept-static");

    await page.click("#intercept-config-link");

    await expect(page.locator("#intercept-config-intercepted")).toHaveText(
      "intercept-static intercept 1 cookie=undefined",
    );
  });

  for (const area of ["slot-owner-error", "slot-owner-static"]) {
    test(`ignores a ${area} source page's dynamic config in a slot`, async ({ page }) => {
      await openWithCookie(page, area);

      await page.click("#intercept-config-link");

      await expect(page.locator("#intercept-config-intercepted")).toHaveText(
        `${area} intercept 1 cookie=v`,
      );
      await expect(page.locator("#intercept-config-owner")).toHaveText(`${area} owner`);
    });
  }
});
