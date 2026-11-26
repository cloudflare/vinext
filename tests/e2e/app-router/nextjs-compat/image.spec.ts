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

  test("keeps alt text transparent until onError, then shows it", async ({ page }) => {
    // Ported from Next.js:
    // test/e2e/next-image-new/app-dir/app-dir.test.ts
    // ("should callback native onError when error occurred while loading image")
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/app-dir/app-dir.test.ts
    await page.goto("/nextjs-compat/image-on-error");
    await waitForAppRouterHydration(page);

    const styleColor = (id: string) =>
      page.locator(`#${id}`).evaluate((element: HTMLElement) => element.style.color);

    await expect(page.locator("#msg1")).toHaveText("no error occurred for img1");
    await expect.poll(() => styleColor("img1")).toBe("transparent");
    await expect(page.locator("#msg2")).toHaveText("no error occurred for img2");
    await expect.poll(() => styleColor("img2")).toBe("transparent");

    await page.locator("#toggle").click();

    await expect(page.locator("#msg2")).toHaveText("error occurred while loading img2");
    await expect.poll(() => styleColor("img2")).toBe("");
    await expect.poll(() => styleColor("img1")).toBe("transparent");
  });
});
