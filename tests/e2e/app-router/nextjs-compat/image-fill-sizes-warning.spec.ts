import { test, expect } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

// Next.js dev warns (from handleLoading in client/image-component.tsx) when a
// `fill` image has no `sizes`, or `sizes="100vw"`, but renders at less than
// 60% of the viewport width. Unoptimized images, an explicit narrower `sizes`
// and wide images don't warn, and each message is logged once.
// The optimized fixtures are 64×64: fill images get a w-descriptor srcSet, and
// a 1×1 source picked at a density above 1 reports a naturalWidth of 0.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/client/image-component.tsx
const MISSING_SIZES_WARNING =
  'Image with src "/image-fill-sizes-missing.png" has "fill" but is missing "sizes" prop. Please add it to improve page performance. Read more: https://nextjs.org/docs/api-reference/next/image#sizes';
const SIZES_100VW_WARNING =
  'Image with src "/image-fill-sizes-100vw.png" has "fill" prop and "sizes" prop of "100vw", but image is not rendered at full viewport width. Please adjust "sizes" to improve page performance. Read more: https://nextjs.org/docs/api-reference/next/image#sizes';

test.describe("next/image fill sizes dev warning", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("warns for narrow fill images missing sizes or using 100vw", async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning") warnings.push(msg.text());
    });

    await page.goto("/nextjs-compat/image-fill-sizes-warning");
    await waitForAppRouterHydration(page);

    const images = [
      { id: "#fill-missing-sizes", width: 300 },
      { id: "#fill-sizes-100vw", width: 300 },
      { id: "#fill-explicit-sizes", width: 300 },
      { id: "#fill-unoptimized", width: 300 },
      { id: "#fill-full-width" },
    ];
    for (const { id, width } of images) {
      const image = page.locator(id);
      await expect
        .poll(() =>
          image.evaluate(
            (el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0,
          ),
        )
        .toBe(true);
      if (width !== undefined) {
        expect((await image.boundingBox())?.width).toBe(width);
      }
    }

    await expect
      .poll(() => warnings.filter((w) => w === MISSING_SIZES_WARNING).length, { timeout: 5_000 })
      .toBe(1);
    await expect
      .poll(() => warnings.filter((w) => w === SIZES_100VW_WARNING).length, { timeout: 5_000 })
      .toBe(1);

    // No warning for the explicit `sizes`, unoptimized or full-width images.
    expect(warnings.filter((w) => w.includes('"sizes"'))).toHaveLength(2);
  });
});
