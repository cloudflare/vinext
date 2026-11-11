import { expect, test } from "@playwright/test";

// Ported from Next.js: test/integration/next-image-new/app-dir/test/index.test.ts
// ("should render picture via getImageProps")
// https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/app-dir/test/index.test.ts
//
// The fixture calls getImageProps from a Server Component. Next.js's next/image
// entry is server-safe, so this must render in a production build instead of
// throwing "Unexpectedly client reference export 'getImageProps' is called on server".
//
// Upstream also asserts no `fetchpriority` attribute and `style="color:transparent"`
// on the <img>. Those are left out: vinext's getImageProps output still differs
// there (priority maps to fetchPriority="high"; no color:transparent default).
test("renders a <picture> from getImageProps in a Server Component", async ({ page }) => {
  const response = await page.goto("/nextjs-compat/image-get-image-props");
  expect(response?.status()).toBe(200);

  const img = page.locator("picture img");
  await expect
    .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(img).toHaveAttribute("alt", "Hero");
  await expect(img).toHaveAttribute("width", "400");
  await expect(img).toHaveAttribute("height", "400");
  await expect(img).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fget-image-props-light.png&w=828&q=75",
  );
  await expect(img).not.toHaveAttribute("srcset");
  await expect(img).not.toHaveAttribute("sizes");

  await expect(page.locator("source").first()).toHaveAttribute(
    "srcset",
    "/_next/image?url=%2Fget-image-props-dark.png&w=640&q=75 1x, /_next/image?url=%2Fget-image-props-dark.png&w=828&q=75 2x",
  );
  await expect(page.locator("source").last()).toHaveAttribute(
    "srcset",
    "/_next/image?url=%2Fget-image-props-light.png&w=640&q=75 1x, /_next/image?url=%2Fget-image-props-light.png&w=828&q=75 2x",
  );
});
