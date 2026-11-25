import { test, expect, type Page } from "@playwright/test";

async function resizeContainer(page: Page, width: number) {
  await page.locator("#image-container").evaluate((container, value) => {
    container.style.width = `${value}px`;
  }, width);
}

async function expectDimensions(page: Page, id: string, width: number, height: number) {
  const image = page.locator(`#${id}`);
  await expect(image).toBeVisible();
  const bounds = await image.boundingBox();
  expect(bounds?.width).toBeCloseTo(width, 1);
  expect(bounds?.height).toBeCloseTo(height, 1);
}

// Ported from Next.js's intrinsic layout resize/aspect-ratio regression:
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-legacy/default/default.test.ts
for (const id of ["default-image", "intrinsic-image"]) {
  test(`legacy ${id} shrinks with its container and keeps its aspect ratio`, async ({ page }) => {
    await page.goto("/legacy-image-layout");
    await expectDimensions(page, id, 640, 320);
    await resizeContainer(page, 320);
    await expectDimensions(page, id, 320, 160);
    await resizeContainer(page, 160);
    await expectDimensions(page, id, 160, 80);
    await resizeContainer(page, 800);
    await expectDimensions(page, id, 640, 320);
  });
}

test("legacy fixed and responsive layouts retain their sizing", async ({ page }) => {
  await page.goto("/legacy-image-layout");
  await expectDimensions(page, "fixed-image", 640, 320);
  await expectDimensions(page, "responsive-image", 800, 400);
  await resizeContainer(page, 160);
  await expectDimensions(page, "fixed-image", 640, 320);
  await expectDimensions(page, "responsive-image", 160, 80);
});
