import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Issue #4810: a page's document carries only its own routes' next/font rules,
// so a client navigation must bring the rules of the target route's server
// components, which never run in the browser. Next.js sends them as the
// route's CSS with the navigation's RSC payload.
test("a client navigation applies the target route's next/font rules", async ({ page }) => {
  await page.goto("/font-navigation/a");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("font-navigation-a")).toHaveCSS("font-family", /fontNavigationA/);
  // The document holds only A's font.
  expect(await page.content()).not.toContain("fontNavigationB");

  await page.evaluate(() => {
    Reflect.set(window, "__fontNavigationDocument", true);
  });
  await page.getByTestId("font-navigation-link").click();
  await expect(page.getByTestId("font-navigation-b")).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__fontNavigationDocument"))).toBe(true);
  await expect(page.getByTestId("font-navigation-b")).toHaveCSS("font-family", /fontNavigationB/);
});

// A route without fonts has no nonce-bearing <style> to copy, so the inserted
// font block takes its nonce from the document's scripts, and a
// `style-src 'nonce-…'` policy still applies it.
test("a client navigation from a fontless route applies the target's fonts under a style nonce", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  await page.goto("/font-navigation/plain?csp-nonce");
  await waitForAppRouterHydration(page);
  expect(await page.locator("style[nonce], style[data-vinext-fonts]").count()).toBe(0);

  await page.getByTestId("font-navigation-plain-link").click();
  await expect(page.getByTestId("font-navigation-b")).toBeVisible();
  await expect(page.getByTestId("font-navigation-b")).toHaveCSS("font-family", /fontNavigationB/);
  expect(violations.filter((text) => text.includes("style"))).toEqual([]);
});
