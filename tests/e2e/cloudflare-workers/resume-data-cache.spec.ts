import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Runs against app-router-playground deployed with --warm-cache and no
// prerender. Ported from Next.js:
// test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
const backend = process.env.VINEXT_E2E_FALLBACK_SHELL_BACKEND;
const route = "/e2e/resume-data-cache";

test.beforeAll(async ({ baseURL, request }) => {
  if (!backend || !baseURL) return;
  test.setTimeout(120_000);
  // A newly deployed Worker can take a moment to serve its workers.dev URL.
  await expect
    .poll(async () => (await request.get(`${baseURL}${route}`)).status(), {
      intervals: [1_000],
      timeout: 90_000,
    })
    .toBe(200);
});

test.describe("cached values across re-renders on a warmed deploy", () => {
  test.skip(!backend, "requires app-router-playground deployed with a cache backend");

  test("keeps the page's cached value in its dynamic RSC render", async ({ baseURL, request }) => {
    const html = await (await request.get(`${baseURL}${route}`)).text();
    const cachedValue = html.match(/<p id="random-number">(cached-0\.\d+)<\/p>/)?.[1];
    expect(cachedValue).toBeTruthy();

    // Every cached value in the dynamic render is the HTML render's, so it
    // didn't run the cached function again. The value the HTML render cached
    // may take a moment to become readable.
    await expect
      .poll(
        async () => {
          const rsc = await (
            await request.get(`${baseURL}${route}`, { headers: { RSC: "1" } })
          ).text();
          return [...new Set(rsc.match(/cached-0\.\d+/g) ?? [])];
        },
        { timeout: 15_000 },
      )
      .toEqual([cachedValue]);
  });

  test("keeps cached values when a server action re-renders the page", async ({
    baseURL,
    page,
  }) => {
    await page.goto(`${baseURL}${route}/server-action`);
    // A form action also works as a native POST before hydration; wait so the
    // click runs the client-side server action re-render.
    await waitForAppRouterHydration(page);
    const cached = page.locator("#cached-random");
    const uncached = page.locator("#uncached-random");
    await expect(uncached).not.toHaveText("Loading...");
    const initialCached = await cached.textContent();
    const initialUncached = await uncached.textContent();

    const actionRequest = page.waitForRequest(
      (request) => request.method() === "POST" && request.headers()["next-action"] !== undefined,
    );
    await page.locator("#refresh-button").click();
    await actionRequest;

    // The re-render ran the uncached function again but reused the cached one.
    await expect
      .poll(async () => {
        const text = await uncached.textContent();
        return text === "Loading..." ? null : text !== initialUncached;
      })
      .toBe(true);
    await expect(cached).toHaveText(initialCached ?? "");
  });
});
