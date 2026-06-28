import { expect, test } from "@playwright/test";

// Ported from Next.js v16.2.6:
// test/e2e/next-form/default/next-form-prefetch.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/next-form/default/next-form-prefetch.test.ts

function isSearchRscRequest(request: import("@playwright/test").Request) {
  const url = new URL(request.url());
  return url.pathname === "/nextjs-compat/next-form/search" && request.headers()["rsc"] === "1";
}

test("prefetch=false does not prefetch", async ({ page, baseURL }) => {
  const prefetchRequests: string[] = [];
  page.on("request", (request) => {
    if (isSearchRscRequest(request)) {
      prefetchRequests.push(request.url());
    }
  });

  await page.goto(`${baseURL}/nextjs-compat/next-form/prefetch-false`);
  await page.waitForTimeout(250);

  expect(prefetchRequests).toEqual([]);
});

test("development does not prefetch forms", async ({ page, baseURL }) => {
  const prefetchRequests: string[] = [];
  page.on("request", (request) => {
    if (isSearchRscRequest(request)) prefetchRequests.push(request.url());
  });

  await page.goto(`${baseURL}/nextjs-compat/next-form/prefetch`);
  await page.waitForTimeout(250);

  expect(prefetchRequests).toEqual([]);
});
