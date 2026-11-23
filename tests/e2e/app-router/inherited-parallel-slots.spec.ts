import { test, expect } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("inherited parallel slot", () => {
  test("renders the mirrored sub-page when one exists (literal)", async ({ page }) => {
    await page.goto(`${BASE}/inherited-slot/about`);
    await expect(page.getByTestId("bc")).toHaveText("crumbs:about");
    await expect(page.getByTestId("page")).toHaveText("about");
  });

  test("renders the mirrored sub-page when one exists (catch-all)", async ({ page }) => {
    await page.goto(`${BASE}/inherited-slot/products/42`);
    // mirrored from @breadcrumbs/[...path]/page.tsx
    await expect(page.getByTestId("bc")).toHaveText("crumbs:products/42");
  });

  test("falls back to default when no mirrored sub-page exists for the segment", async ({
    page,
  }) => {
    await page.goto(`${BASE}/inherited-slot`);
    // no @breadcrumbs/page.tsx exists at the slot root
    await expect(page.getByTestId("bc")).toHaveText("[default]");
  });

  test("renders mirrored sub-page when slot's dynamic param has a different name", async ({
    page,
  }) => {
    await page.goto(`${BASE}/inherited-slot/distinct/foo`);
    // route has [id], slot has [name] — both single dynamics, distinct names.
    await expect(page.getByTestId("page")).toHaveText("id:foo");
    await expect(page.getByTestId("bc")).toHaveText("name:foo");
  });

  test("keeps a sibling slot's own params beneath a modal opened from its route", async ({
    page,
  }) => {
    const feedPathname = "/nextjs-compat/intercept-source-slot-params/team/feed";
    await page.goto(`${BASE}${feedPathname}`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#intercept-source-slot-params-sidebar-path")).toHaveText(
      "Sidebar: feed",
    );
    const counter = page.locator("#intercept-source-slot-params-sidebar-count");
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("Sidebar count: 2");
    const feedRendered = page.locator("#intercept-source-slot-params-feed-rendered");
    const feedRenderedAt = await feedRendered.textContent();
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });
    const feedRefetches: string[] = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, feedPathname)) feedRefetches.push(request.url());
    });

    // Like Next.js, the modal opens over the feed the client already holds,
    // and the sidebar keeps the params and state the feed's render gave it.
    await page.getByRole("link", { name: "Photo 1" }).click();
    await expect(page).toHaveURL(/\/intercept-source-slot-params\/photos\/1$/);
    await expect(page.locator("#intercept-source-slot-params-modal")).toHaveText("Photo modal: 1");
    await expect(feedRendered).toHaveText(feedRenderedAt!);
    await expect(page.locator("#intercept-source-slot-params-photo")).toHaveCount(0);
    await expect(page.locator("#intercept-source-slot-params-sidebar-path")).toHaveText(
      "Sidebar: feed",
    );
    await expect(counter).toHaveText("Sidebar count: 2");
    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
    expect(feedRefetches).toEqual([]);
  });
});
