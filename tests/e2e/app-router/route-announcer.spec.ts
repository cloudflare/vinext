import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// Ported from Next.js's App Router announcer
// (packages/next/src/client/components/app-router-announcer.tsx) and its
// test/e2e/app-dir/app-a11y suite: a <next-route-announcer> element whose
// shadow root holds a <div role="alert" aria-live="assertive">, which receives
// the new document.title after each committed soft navigation, but not on
// first load. The region holds the bare title, the innerHTML that app-a11y
// checks.
async function readAnnouncer(page: Page) {
  return page.evaluate(() => {
    const host = document.getElementsByTagName("next-route-announcer")[0];
    const node = host?.shadowRoot?.querySelector('[aria-live="assertive"]');
    return node
      ? { role: node.getAttribute("role"), text: node.textContent, html: node.innerHTML }
      : null;
  });
}

function announced(title: string) {
  return { role: "alert", text: title, html: title };
}

// Browser translation (Chrome Translate) swaps the announcement's text node
// for <font> elements, as in vercel/next.js#99353. It either replaces the text
// or moves the original text node inside them.
async function translateAnnouncement(page: Page, mode: "replace" | "reparent") {
  await page.evaluate((mode) => {
    const host = document.getElementsByTagName("next-route-announcer")[0];
    const region = host.shadowRoot!.querySelector('[aria-live="assertive"]')!;
    const text = document.createTreeWalker(region, NodeFilter.SHOW_TEXT).nextNode()!;
    const outer = document.createElement("font");
    const inner = document.createElement("font");
    outer.appendChild(inner);
    text.parentNode!.replaceChild(outer, text);
    if (mode === "reparent") inner.appendChild(text);
    else inner.textContent = "Translated announcement";
  }, mode);
}

// Loads the start page, waits for hydration, and checks that nothing is
// announced on first load. Returns the page errors seen from then on.
async function loadStartPage(page: Page) {
  // The first request compiles the routes on the dev server.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/route-announcer`);
  await expect(page.locator("h1")).toHaveText("Route Announcer Start");
  await waitForAppRouterHydration(page);

  // Screen readers already read a fresh document: nothing is announced.
  // The region holds no markup at all, as Next.js's app-a11y test checks.
  await expect.poll(() => readAnnouncer(page)).toEqual(announced(""));

  await page.evaluate(() => {
    (window as any).__ANNOUNCER_NAV_MARKER__ = true;
  });
  return errors;
}

// Checks that every navigation so far was a soft one, with a single announcer
// host and no page errors.
async function expectSoftNavigations(page: Page, errors: string[]) {
  expect(await page.evaluate(() => (window as any).__ANNOUNCER_NAV_MARKER__)).toBe(true);
  expect(
    await page.evaluate(() => document.getElementsByTagName("next-route-announcer").length),
  ).toBe(1);
  expect(errors).toEqual([]);
}

test.describe("App Router route announcer", () => {
  test("announces the destination title after a soft navigation", async ({ page }) => {
    const errors = await loadStartPage(page);

    await page.click("#to-destination");
    await expect(page.locator("h1")).toHaveText("Route Announcer Destination");
    await expect(page).toHaveTitle("Route Announcer Destination");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Destination"));

    // After either kind of translation, the next announcement must still
    // reach the live region.
    await translateAnnouncement(page, "replace");
    await page.click("#to-start");
    await expect(page.locator("h1")).toHaveText("Route Announcer Start");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Start"));

    await translateAnnouncement(page, "reparent");
    await page.click("#to-destination");
    await expect(page.locator("h1")).toHaveText("Route Announcer Destination");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Destination"));

    await expectSoftNavigations(page, errors);
  });

  test("announces history navigations, and only when the title changes", async ({ page }) => {
    const errors = await loadStartPage(page);

    await page.click("#to-destination");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Destination"));

    // Record the region's text after every change from here on.
    await page.evaluate(() => {
      const host = document.getElementsByTagName("next-route-announcer")[0];
      const region = host.shadowRoot!.querySelector('[aria-live="assertive"]')!;
      const changes: (string | null)[] = [];
      (window as any).__ANNOUNCER_CHANGES__ = changes;
      new MutationObserver(() => changes.push(region.textContent)).observe(region, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });

    // Same title at another URL, then back to it: nothing to announce.
    await page.click("#to-destination-again");
    await expect(page).toHaveURL(`${BASE}/route-announcer/destination?same=1`);
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/route-announcer/destination`);

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Route Announcer Start");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Start"));

    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Route Announcer Destination");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Destination"));

    // Only the two title changes touched the region.
    expect(await page.evaluate(() => (window as any).__ANNOUNCER_CHANGES__)).toEqual([
      "Route Announcer Start",
      "Route Announcer Destination",
    ]);
    await expectSoftNavigations(page, errors);
  });

  test("announces the h1 without a title, and empties the region with neither, after translation", async ({
    page,
  }) => {
    const errors = await loadStartPage(page);

    await page.click("#to-destination");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Destination"));

    await page.click("#to-untitled");
    await expect(page.locator("h1")).toHaveText("Route Announcer Untitled Heading");
    await expect(page).toHaveTitle("");
    await expect
      .poll(() => readAnnouncer(page))
      .toEqual(announced("Route Announcer Untitled Heading"));

    // With no title and no h1 the announcement is empty, and Next.js empties
    // the region. After translation, React removing its own text node there
    // throws removeChild and breaks navigation (vercel/next.js#99353).
    await translateAnnouncement(page, "reparent");
    await page.click("#to-no-heading");
    await expect(page.getByText("Route Announcer No Heading")).toBeVisible();
    await expect.poll(() => readAnnouncer(page)).toEqual(announced(""));

    await page.click("#to-start");
    await expect(page.locator("h1")).toHaveText("Route Announcer Start");
    await expect.poll(() => readAnnouncer(page)).toEqual(announced("Route Announcer Start"));

    await expectSoftNavigations(page, errors);
  });
});
