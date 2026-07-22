import { test, expect } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

test.describe("next/image", () => {
  test("removes blur placeholder after a transparent image loads", async ({
    page,
    consoleErrors,
  }) => {
    // Ported from Next.js:
    // test/e2e/next-image-new/app-dir/app-dir.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/app-dir/app-dir.test.ts
    await page.goto("/nextjs-compat/image-blur-placeholder");
    await waitForAppRouterHydration(page);

    const image = page.locator("#transparent-image");

    await expect
      .poll(async () =>
        image.evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);

    await expect
      .poll(async () => image.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toBe("none");

    void consoleErrors;
  });
});
