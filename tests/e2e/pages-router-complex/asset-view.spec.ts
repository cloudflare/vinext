import { test, expect } from "@playwright/test";

/**
 * The `[collection]/item/[assetId]` page-data function branches into three
 * templates off what the catalogue record says the asset is, and 404s
 * malformed ids, unknown ids, and withdrawn records before rendering.
 */
test.describe("asset view template branching", () => {
  test("clip records render the clip template", async ({ page }) => {
    await page.goto("/skies/item/1101");
    await expect(page.locator('[data-testid="asset-view"]')).toHaveAttribute(
      "data-template",
      "clip",
    );
    await expect(page.locator('[data-testid="clip-player"]')).toHaveAttribute(
      "data-manifest",
      /streams\/1101\.m3u8$/,
    );
  });

  test("pack records render the pack template with contents", async ({ page }) => {
    await page.goto("/boxed-set/item/3001");
    await expect(page.locator('[data-testid="asset-view"]')).toHaveAttribute(
      "data-template",
      "pack",
    );
    await expect(page.locator('[data-testid="pack-contents"] li')).toHaveCount(2);
  });

  test("other kinds render the standard template", async ({ page }) => {
    await page.goto("/tides/item/1201");
    await expect(page.locator('[data-testid="asset-view"]')).toHaveAttribute(
      "data-template",
      "standard",
    );
    await expect(page.locator('[data-testid="asset-kind"]')).toHaveText("track");
  });

  test("withdrawn records 404 with the shared missing screen", async ({ page }) => {
    const response = await page.goto("/skies/item/1999");
    expect(response?.status()).toBe(404);
    await expect(page.locator('[data-testid="fault-screen-404"]')).toBeVisible();
  });

  test("malformed asset ids 404", async ({ request }) => {
    const response = await request.get("/skies/item/not-an-id");
    expect(response.status()).toBe(404);
  });

  test("unknown asset ids 404", async ({ request }) => {
    const response = await request.get("/skies/item/4242");
    expect(response.status()).toBe(404);
  });
});
