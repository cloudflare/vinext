import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

// Next.js lets Client Components import next/cache, whose browser build
// keeps server internals out of the bundle and turns unstable_cache into a
// pass-through.
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/cache.js
test("Client Components can import and call unstable_cache in dev", async ({ page }) => {
  // A Node.js builtin reached from next/cache fails in the browser, and the
  // error boundary reports it as a console error rather than a page error.
  const builtinErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("externalized for browser")) {
      builtinErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => builtinErrors.push(error.message));

  await page.goto(`${BASE}/nextjs-compat/unstable-cache-client`);

  await expect(page.getByTestId("client-greeting")).toHaveText("hello client");
  expect(builtinErrors).toEqual([]);
});
