import { test, expect } from "@playwright/test";

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
});
