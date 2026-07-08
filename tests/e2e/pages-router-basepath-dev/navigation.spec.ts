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

test("soft navigates with basePath module URLs after ISR regeneration", async ({
  page,
  request,
}) => {
  const firstResponse = await request.get("/docs/isr-basepath");
  expect(firstResponse.ok()).toBe(true);
  const firstHtml = await firstResponse.text();
  const firstGeneratedAt = firstHtml.match(/data-testid="generated-at">(\d+)</)?.[1];
  expect(firstGeneratedAt).toBeDefined();

  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const staleResponse = await request.get("/docs/isr-basepath");
  expect(staleResponse.headers()["x-vinext-cache"]).toBe("STALE");

  let regeneratedHtml = "";
  await expect
    .poll(async () => {
      const response = await request.get("/docs/isr-basepath");
      regeneratedHtml = await response.text();
      return {
        cache: response.headers()["x-vinext-cache"],
        changed:
          regeneratedHtml.match(/data-testid="generated-at">(\d+)</)?.[1] !== firstGeneratedAt,
      };
    })
    .toEqual({ cache: "HIT", changed: true });

  const regeneratedAt = regeneratedHtml.match(/data-testid="generated-at">(\d+)</)?.[1];
  expect(regeneratedAt).toBeDefined();

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
  await expect(page.getByTestId("generated-at")).toHaveText(regeneratedAt!);
  await expect(page).toHaveURL(/\/docs\/isr-basepath$/);
  expect(await page.evaluate(() => (window as any).__VINEXT_SOFT_NAV_MARKER__)).toBe(true);
  expect(moduleRequests).toContain("/docs/pages/isr-basepath.tsx?import");
  expect(moduleRequests).not.toContain("/pages/isr-basepath.tsx?import");
  expect(moduleRequests.every((moduleRequest) => moduleRequest.startsWith("/docs/"))).toBe(true);
});
