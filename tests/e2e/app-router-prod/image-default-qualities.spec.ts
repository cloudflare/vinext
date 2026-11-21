import { expect, test } from "@playwright/test";

const optimizedUrl = (width: number, quality: number) =>
  `/_next/image?url=%2Fget-image-props-light.png&w=${width}&q=${quality}`;

// Intentional divergence from Next.js 16, which defaults `images.qualities` to
// `[75]` (400 for any other `q`, and the default loader rounds `quality={90}`
// to 75). vinext keeps the Next.js 14/15 behaviour when the list is unset, so
// apps migrating from those versions keep the qualities they pass. The fixture
// configures no `images.qualities`.
test.describe("unset images.qualities", () => {
  test("the image endpoint accepts any quality from 1 to 100", async ({ request }) => {
    for (const quality of [1, 70, 75, 90, 100]) {
      const response = await request.get(optimizedUrl(64, quality));
      expect(response.status(), `q=${quality}`).toBe(200);
      expect(response.headers()["content-type"], `q=${quality}`).toBe("image/png");
    }
    for (const quality of [0, 101]) {
      const response = await request.get(optimizedUrl(64, quality));
      expect(response.status(), `q=${quality}`).toBe(400);
    }
  });

  test("next/image keeps the quality prop as written", async ({ page }) => {
    const response = await page.goto("/nextjs-compat/image-default-qualities");
    expect(response?.status()).toBe(200);

    for (const [id, quality] of [
      ["server-quality-90", 90],
      ["client-quality-90", 90],
      ["server-no-quality", 75],
    ] as const) {
      const img = page.locator(`#${id}`);
      await expect(img).toHaveAttribute("src", optimizedUrl(128, quality));
      await expect(img).toHaveAttribute(
        "srcset",
        `${optimizedUrl(64, quality)} 1x, ${optimizedUrl(128, quality)} 2x`,
      );
      await expect
        .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
  });
});
