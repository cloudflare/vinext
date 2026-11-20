import { expect, test, type Page } from "@playwright/test";

// Production counterpart of the Next.js image-sizing-warning development
// fixture. Distorted images must not warn when NODE_ENV is production.
// Ported from Next.js: test/development/app-dir/image-sizing-warning/image-sizing-warning.test.ts
// https://github.com/vercel/next.js/blob/canary/test/development/app-dir/image-sizing-warning/image-sizing-warning.test.ts

const ROUTE = "/nextjs-compat/image-sizing-warning";

function collectConsoleMessages(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  return messages;
}

test("does not warn about aspect-ratio distortion in production", async ({ page }) => {
  const messages = collectConsoleMessages(page);
  const response = await page.goto(ROUTE);
  expect(response?.status()).toBe(200);

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.images.length === 18 &&
          Array.from(document.images).every((img) => img.dataset.loaded === "true"),
      ),
    )
    .toBe(true);

  expect(messages.filter((message) => message.includes("aspect ratio"))).toEqual([]);
});
