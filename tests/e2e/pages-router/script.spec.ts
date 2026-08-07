import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";

const BASE = "http://localhost:4173";

test.describe("next/script", () => {
  test("uses weak comparison for public-file If-None-Match requests", async ({ request }) => {
    const initial = await request.get(`${BASE}/dedupe-script.js`);
    const etag = initial.headers().etag;
    expect(etag).toMatch(/^W\//);

    const strong = etag.slice(2);
    const strongResponse = await request.get(`${BASE}/dedupe-script.js`, {
      headers: { "If-None-Match": strong },
    });
    expect(strongResponse.status()).toBe(304);

    const listResponse = await request.get(`${BASE}/dedupe-script.js`, {
      headers: { "If-None-Match": `"other", ${strong}` },
    });
    expect(listResponse.status()).toBe(304);

    const headResponse = await request.head(`${BASE}/dedupe-script.js`, {
      headers: { "If-None-Match": strong },
    });
    expect(headResponse.status()).toBe(304);

    const normalizedPathStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${BASE}/nested/%2e%2e//dedupe-script.js`,
        { headers: { "If-None-Match": strong } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(normalizedPathStatus).toBe(304);
  });

  // Ported from Next.js: packages/next/src/client/script.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/script.tsx
  // Next.js keeps a ScriptCache for in-flight remote scripts so same-src
  // components mounted together only append one DOM script.
  test("deduplicates simultaneous same-src scripts before load completes", async ({ page }) => {
    await page.goto(`${BASE}/script-dedupe`);
    await expect(page.getByRole("heading", { name: "Script Dedupe" })).toBeVisible();

    await expect.poll(() => page.locator('script[src="/dedupe-script.js"]').count()).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextScriptDedupeExecutions")))
      .toBe(1);
  });
});
