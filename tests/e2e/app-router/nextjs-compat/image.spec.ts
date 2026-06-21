import { test, expect } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";
import { createServer } from "node:http";

test.describe("next/image", () => {
  test("optimizes remote images through the generated dev handler", async ({ request }) => {
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const origin = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(imageBytes);
    });
    await new Promise<void>((resolve) => origin.listen(4199, "127.0.0.1", resolve));

    try {
      const source = "http://127.0.0.1:4199/photo.png";
      const response = await request.get(
        `/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`,
      );

      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("image/png");
      expect(await response.body()).toEqual(imageBytes);
    } finally {
      await new Promise<void>((resolve, reject) =>
        origin.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

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
