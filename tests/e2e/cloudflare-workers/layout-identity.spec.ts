import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:4176";
const PARENT = `${BASE}/layout-identity/alpha`;

const readLayoutHandle = (page: Page) =>
  page.evaluateHandle(() => document.querySelector('[data-testid="shared-layout"]'));

// `/layout-identity/[slug]` and everything beneath it share the `[slug]` layout
// and resolve the same slug value, so navigating between them changes only the
// segments below that layout. The layout must stay mounted: its DOM node keeps
// its identity and the client state it owns survives.
//
// vinext currently discards the layout subtree on these navigations. The trigger
// is the `loading.tsx` boundary above the shared layout — with that file removed
// from the fixture, every assertion below passes.
test.describe("App Router shared layout identity", () => {
  test("navigates without a full document load", async ({ page }) => {
    await page.goto(PARENT);
    await expect(page.getByTestId("page-title")).toHaveText("Parent page");

    await page.evaluate(() => {
      (window as Window & { __softNavigationMarker?: boolean }).__softNavigationMarker = true;
    });

    await page.getByTestId("to-child").click();
    await expect(page.getByTestId("page-title")).toHaveText("Child page");

    // Control: the marker survives, so this is a client-side navigation rather
    // than a document load. The teardown below is therefore the router
    // discarding a layout it should have retained, not a full page reload.
    const marker = await page.evaluate(
      () => (window as Window & { __softNavigationMarker?: boolean }).__softNavigationMarker,
    );
    expect(marker).toBe(true);
  });

  test("keeps the shared layout element mounted across a static child segment", async ({
    page,
  }) => {
    await page.goto(PARENT);
    await expect(page.getByTestId("page-title")).toHaveText("Parent page");

    const layout = await readLayoutHandle(page);
    expect(await layout.evaluate((element) => element?.isConnected ?? false)).toBe(true);

    await page.getByTestId("to-child").click();
    await expect(page.getByTestId("page-title")).toHaveText("Child page");

    // The same DOM node must still be in the document: a retained layout is
    // reconciled in place, a discarded one is replaced by a fresh element.
    expect(await layout.evaluate((element) => element?.isConnected ?? false)).toBe(true);
  });

  test("keeps the shared layout element mounted across a nested dynamic segment", async ({
    page,
  }) => {
    await page.goto(PARENT);
    await expect(page.getByTestId("page-title")).toHaveText("Parent page");

    const layout = await readLayoutHandle(page);

    // Crosses two layout levels at once: the shared `[slug]` layout stays on the
    // same value while `items/[item]` mounts its own layout beneath it.
    await page.getByTestId("to-item").click();
    await expect(page.getByTestId("page-title")).toHaveText("Item page");
    await expect(page.getByTestId("item-layout-value")).toHaveText("Item layout: first");

    expect(await layout.evaluate((element) => element?.isConnected ?? false)).toBe(true);
  });

  test("preserves client state owned by the shared layout", async ({ page }) => {
    await page.goto(PARENT);
    await page.getByTestId("layout-increment").click();
    await expect(page.getByTestId("layout-count")).toHaveText("Layout count: 1");

    await page.getByTestId("to-child").click();
    await expect(page.getByTestId("page-title")).toHaveText("Child page");

    // The counter lives in the layout, not the page, so it only resets when the
    // layout remounts.
    await expect(page.getByTestId("layout-count")).toHaveText("Layout count: 1");
  });

  test("keeps the shared layout mounted when navigating back to the parent", async ({ page }) => {
    await page.goto(`${PARENT}/items/first`);
    await expect(page.getByTestId("page-title")).toHaveText("Item page");

    const layout = await readLayoutHandle(page);

    await page.getByTestId("to-parent").click();
    await expect(page.getByTestId("page-title")).toHaveText("Parent page");

    expect(await layout.evaluate((element) => element?.isConnected ?? false)).toBe(true);
  });

  test("updates the parallel slot alongside the retained layout", async ({ page }) => {
    await page.goto(PARENT);
    await expect(page.getByTestId("aside-content")).toHaveText("aside: alpha parent");

    const layout = await readLayoutHandle(page);

    await page.getByTestId("to-item").click();
    await expect(page.getByTestId("aside-content")).toHaveText("aside: alpha / first");

    // The slot beside `children` changing must not cost the sibling layout its
    // identity.
    expect(await layout.evaluate((element) => element?.isConnected ?? false)).toBe(true);
  });
});
