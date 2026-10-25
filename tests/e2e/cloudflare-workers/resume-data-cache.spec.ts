import { expect, test } from "@playwright/test";

// Runs against app-router-playground deployed with --warm-cache and no
// prerender. Ported from Next.js:
// test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
const backend = process.env.VINEXT_E2E_FALLBACK_SHELL_BACKEND;

test.describe("cached values across re-renders on a warmed deploy", () => {
  test.skip(!backend, "requires app-router-playground deployed with a cache backend");

  test("keeps the page's cached value in its dynamic RSC render", async ({ baseURL, request }) => {
    const route = `${baseURL}/e2e/resume-data-cache`;
    const html = await (await request.get(route)).text();
    const randomNumber = html.match(/<p id="random-number">([^<]+)<\/p>/)?.[1];
    expect(randomNumber).toBeTruthy();

    // The value the HTML render cached may take a moment to become readable.
    await expect
      .poll(async () => (await request.get(route, { headers: { RSC: "1" } })).text(), {
        timeout: 15_000,
      })
      .toContain(randomNumber);
  });

  test("keeps cached values when a server action re-renders the page", async ({
    baseURL,
    page,
  }) => {
    await page.goto(`${baseURL}/e2e/resume-data-cache/server-action`);
    const cached = page.locator("#cached-random");
    const uncached = page.locator("#uncached-random");
    await expect(uncached).not.toHaveText("Loading...");
    const initialCached = await cached.textContent();
    const initialUncached = await uncached.textContent();

    await page.locator("#refresh-button").click();

    // The re-render ran the uncached function again but reused the cached one.
    await expect(uncached).not.toHaveText(initialUncached ?? "");
    await expect(uncached).not.toHaveText("Loading...");
    await expect(cached).toHaveText(initialCached ?? "");
  });
});
