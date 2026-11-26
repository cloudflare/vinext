import { test, expect, type Page } from "@playwright/test";

// next/legacy/image renders this 1x1 GIF until its IntersectionObserver sees
// the image (client/legacy/image.tsx `emptyDataURL`).
const EMPTY_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function src(page: Page, id: string) {
  return page.locator(`#${id}`).getAttribute("src");
}

// Ported from Next.js: test/e2e/next-image-legacy/default/default.test.ts
// ("should initially load only two of four images using lazyroot",
// "should re-lazyload images after src changes",
// "should remove blurry placeholder after image loads")
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-legacy/default/default.test.ts
test("legacy lazy images server-render a placeholder and a noscript fallback", async ({ page }) => {
  const html = await (await page.request.get("/legacy-image-lazy")).text();
  expect(html).toContain(`id="far-image" alt="far" src="${EMPTY_DATA_URL}"`);
  // One fallback per lazy or blur image.
  expect(html.match(/<noscript>/g)).toHaveLength(3);
});

test("legacy images load once they intersect their lazyRoot", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await expect(page.locator("#near-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );
  expect(await src(page, "far-image")).toBe(EMPTY_DATA_URL);

  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );
});

test("legacy images lazy-load again after their src changes", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );

  await page.locator("#lazy-root").evaluate((root) => root.scrollTo(0, 0));
  await page.locator("#change-src").click();
  await expect(page.locator("#far-image")).toHaveAttribute("src", EMPTY_DATA_URL);

  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute("src", "/logo.svg");
});

test("legacy blur placeholders clear once the image loads", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await expect
    .poll(() =>
      page
        .locator("#blurry-image")
        .evaluate((img) => getComputedStyle(img).getPropertyValue("background-image")),
    )
    .toBe("none");
});
