import { expect, test } from "@playwright/test";

const optimizedUrl = (width: number) =>
  `/_next/image?url=%2Fget-image-props-light.png&w=${width}&q=75`;

// Verified against Next.js 16.2.7 `next start` on an app without
// `images.qualities`: the default is `[75]`, so the endpoint answers 400 for
// any other quality, and the default loader rounds `quality={90}` to 75 in
// Server and Client Components (findClosestQuality in
// packages/next/src/shared/lib/find-closest-quality.ts).
test.describe("images.qualities default", () => {
  test("the image endpoint allows only quality 75", async ({ request }) => {
    for (const quality of [1, 70, 90, 100]) {
      const response = await request.get(
        `/_next/image?url=%2Fget-image-props-light.png&w=64&q=${quality}`,
      );
      expect(response.status(), `q=${quality}`).toBe(400);
    }

    const response = await request.get(optimizedUrl(64));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });

  test("next/image rounds quality={90} to 75", async ({ page }) => {
    const response = await page.goto("/nextjs-compat/image-default-qualities");
    expect(response?.status()).toBe(200);

    for (const id of ["server-quality-90", "client-quality-90"]) {
      const img = page.locator(`#${id}`);
      await expect(img).toHaveAttribute("src", optimizedUrl(128));
      await expect(img).toHaveAttribute(
        "srcset",
        `${optimizedUrl(64)} 1x, ${optimizedUrl(128)} 2x`,
      );
      await expect
        .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
  });
});
