import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// Ported from Next.js's App Router announcer
// (packages/next/src/client/components/app-router-announcer.tsx) and its
// test/e2e/app-dir/app-a11y suite: a <next-route-announcer> element whose
// shadow root holds a <div role="alert" aria-live="assertive">, which receives
// the new document.title after each committed soft navigation, but not on
// first load.
async function readAnnouncer(page: Page) {
  return page.evaluate(() => {
    const host = document.getElementsByTagName("next-route-announcer")[0];
    const node = host?.shadowRoot?.querySelector('[aria-live="assertive"]');
    return node
      ? { role: node.getAttribute("role"), text: node.textContent, html: node.innerHTML }
      : null;
  });
}

test.describe("App Router route announcer", () => {
  test("announces the destination title after a soft navigation", async ({ page }) => {
    // The first request compiles the routes on the dev server.
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/route-announcer`);
    await expect(page.locator("h1")).toHaveText("Route Announcer Start");
    await waitForAppRouterHydration(page);

    // Screen readers already read a fresh document: nothing is announced.
    // The region holds no markup at all, as Next.js's app-a11y test checks.
    await expect.poll(() => readAnnouncer(page)).toEqual({ role: "alert", text: "", html: "" });

    await page.evaluate(() => {
      (window as any).__ANNOUNCER_NAV_MARKER__ = true;
    });
    await page.click("#to-destination");
    await expect(page.locator("h1")).toHaveText("Route Announcer Destination");
    await expect(page).toHaveTitle("Route Announcer Destination");
    expect(await page.evaluate(() => (window as any).__ANNOUNCER_NAV_MARKER__)).toBe(true);

    await expect
      .poll(() => readAnnouncer(page))
      .toMatchObject({ role: "alert", text: "Route Announcer Destination" });

    // Browser translation (Chrome Translate) swaps the announcement's text
    // node for <font> elements, as in vercel/next.js#99353. The next
    // announcement must still reach the live region.
    await page.evaluate(() => {
      const host = document.getElementsByTagName("next-route-announcer")[0];
      const region = host.shadowRoot!.querySelector('[aria-live="assertive"]')!;
      const text = document.createTreeWalker(region, NodeFilter.SHOW_TEXT).nextNode()!;
      const outer = document.createElement("font");
      const inner = document.createElement("font");
      outer.appendChild(inner);
      inner.textContent = "Translated announcement";
      text.parentNode!.replaceChild(outer, text);
    });

    await page.click("#to-start");
    await expect(page.locator("h1")).toHaveText("Route Announcer Start");
    expect(await page.evaluate(() => (window as any).__ANNOUNCER_NAV_MARKER__)).toBe(true);
    await expect
      .poll(() => readAnnouncer(page))
      .toMatchObject({ role: "alert", text: "Route Announcer Start" });

    // A single announcer host, however many navigations commit.
    expect(
      await page.evaluate(() => document.getElementsByTagName("next-route-announcer").length),
    ).toBe(1);
    expect(errors).toEqual([]);
  });
});
