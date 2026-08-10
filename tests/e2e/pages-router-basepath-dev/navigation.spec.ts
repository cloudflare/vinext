import { expect, test } from "@playwright/test";

// Ported from Next.js: test/e2e/basepath/router-events.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/router-events.test.ts
test("loads the target page module through the dev server basePath", async ({ page }) => {
  const moduleRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/pages/about.tsx")) {
      moduleRequests.push(url.pathname + url.search);
    }
  });

  await page.goto("/docs/");
  await page.waitForFunction(() => Boolean((window as any).__VINEXT_ROOT__));
  await page.evaluate(() => {
    (window as any).__VINEXT_SOFT_NAV_MARKER__ = true;
  });

  const initialNavigationEntries = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  await page.getByRole("link", { name: "About" }).click();

  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page).toHaveURL(/\/docs\/about$/);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(
    initialNavigationEntries,
  );
  expect(await page.evaluate(() => (window as any).__VINEXT_SOFT_NAV_MARKER__)).toBe(true);
  expect(moduleRequests).toContain("/docs/pages/about.tsx?import");
  expect(moduleRequests).not.toContain("/pages/about.tsx?import");
  expect(moduleRequests.every((request) => request.startsWith("/docs/"))).toBe(true);
});

test("soft navigates with basePath module URLs after a fresh GSP render", async ({
  page,
  request,
}) => {
  const firstResponse = await request.get("/docs/isr-basepath");
  expect(firstResponse.ok()).toBe(true);
  const firstHtml = await firstResponse.text();
  const firstGeneration = Number(firstHtml.match(/data-testid="generation">(\d+)</)?.[1]);
  expect(firstGeneration).toBeGreaterThan(0);

  const secondResponse = await request.get("/docs/isr-basepath");
  expect(secondResponse.ok()).toBe(true);
  const secondHtml = await secondResponse.text();
  const secondGeneration = Number(secondHtml.match(/data-testid="generation">(\d+)</)?.[1]);
  expect(secondGeneration).toBeGreaterThan(firstGeneration);

  for (const response of [firstResponse, secondResponse]) {
    expect(response.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  }

  const moduleRequests: string[] = [];
  page.on("request", (moduleRequest) => {
    const url = new URL(moduleRequest.url());
    if (url.pathname.endsWith("/pages/isr-basepath.tsx")) {
      moduleRequests.push(url.pathname + url.search);
    }
  });

  await page.goto("/docs/");
  await page.waitForFunction(() => Boolean((window as any).__VINEXT_ROOT__));
  await page.evaluate(() => {
    (window as any).__VINEXT_SOFT_NAV_MARKER__ = true;
  });

  await page.getByRole("link", { name: "ISR" }).click();

  await expect(page.getByRole("heading", { name: "ISR BasePath" })).toBeVisible();
  await expect
    .poll(async () => Number(await page.getByTestId("generation").textContent()))
    .toBeGreaterThan(secondGeneration);
  await expect(page).toHaveURL(/\/docs\/isr-basepath$/);
  expect(await page.evaluate(() => (window as any).__VINEXT_SOFT_NAV_MARKER__)).toBe(true);
  expect(moduleRequests).toContain("/docs/pages/isr-basepath.tsx?import");
  expect(moduleRequests).not.toContain("/pages/isr-basepath.tsx?import");
  expect(moduleRequests.every((moduleRequest) => moduleRequest.startsWith("/docs/"))).toBe(true);
});

test("normalizes local redirect paths after basePath without changing data or external URLs", async ({
  request,
}) => {
  const local = await request.get("/docs/basepath-redirect/slashes", { maxRedirects: 0 });
  expect(local.status()).toBe(308);
  expect(local.headers().location).toBe("/docs/hello/world/deep?keep=//query\\value");
  expect(local.headers().refresh).toBe("0;url=/docs/hello/world/deep?keep=//query\\value");

  const data = await request.get(
    "/docs/_next/data/basepath-dev-build/basepath-redirect/slashes.json",
  );
  expect(await data.json()).toMatchObject({
    pageProps: {
      __N_REDIRECT: "/hello//world\\deep?keep=//query\\value",
      __N_REDIRECT_STATUS: 308,
    },
  });

  const external = await request.get("/docs/basepath-redirect/external", {
    maxRedirects: 0,
  });
  expect(external.headers().location).toBe("https://example.com/a//b\\c?keep=//query\\value");
});
