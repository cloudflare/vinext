import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/head client-side updates", () => {
  test("title changes when navigating between pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Hello vinext");

    // Navigate to about page — title should change
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    // After client navigation, the head shim should update document.title
    await expect(page).toHaveTitle("About - vinext");
  });

  test("title is correct on SSR (no JS)", async ({ page }) => {
    // Disable JS — verify the title comes from SSR
    await page.route("**/*.js", (route) => route.abort());
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Hello vinext");
  });

  test("meta tags are present in SSR head", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // These come from _document or _app or the page itself
    const charset = await page.locator('meta[charSet="utf-8"]').count();
    expect(charset).toBeGreaterThan(0);
  });
});

test.describe("next/dynamic", () => {
  test("dynamically imported component renders on SSR", async ({ page }) => {
    // Disable JS — verify SSR includes the dynamic component
    await page.route("**/*.js", (route) => route.abort());
    await page.goto(`${BASE}/dynamic-page`);

    await expect(page.locator("h1")).toHaveText("Dynamic Import Page");
    // The heavy component should be SSR-rendered (ssr: true by default)
    await expect(page.getByRole("heading", { level: 2, name: "Heavy Component" })).toBeVisible();
  });

  test("dynamically imported component is interactive after hydration", async ({ page }) => {
    await page.goto(`${BASE}/dynamic-page`);

    await expect(page.locator("h1")).toHaveText("Dynamic Import Page");
    await expect(page.getByRole("heading", { level: 2, name: "Heavy Component" })).toBeVisible();
    await expect(page.locator("text=Loaded dynamically")).toBeVisible();
  });

  // Next's Pages Router loadable never suspends: a dynamic() that mounts on a
  // client navigation renders its (null by default) loading state in place,
  // so the new page commits right away. vinext keeps its Suspense boundary
  // in Pages trees so a navigation commits the same way instead of keeping the
  // previous page on screen until the slow chunk loads.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/loadable.shared-runtime.tsx
  test("client navigation commits before a dynamic() without loading resolves", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${BASE}/dynamic-no-loading-link`);
    await page.waitForFunction(() => window.__NEXT_HYDRATED === true);
    await page.evaluate(() => {
      const state = window as unknown as { __sawPageBeforeDynamic?: boolean };
      state.__sawPageBeforeDynamic = false;
      new MutationObserver(() => {
        if (
          document.querySelector("#dynamic-no-loading-title") &&
          !document.querySelector(".slow-dynamic-content")
        ) {
          state.__sawPageBeforeDynamic = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.click("#to-dynamic-no-loading");
    await expect(page.locator(".slow-dynamic-content")).toHaveText("Loaded without loading option");
    expect(
      await page.evaluate(
        () => (window as unknown as { __sawPageBeforeDynamic?: boolean }).__sawPageBeforeDynamic,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  // A separate client root in a Pages document (e.g. a modal library's root)
  // sits outside the page's React tree, but it must still render the rest of
  // its tree while a dynamic() without loading is pending.
  test("a separate client root commits before a dynamic() without loading resolves", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const state = window as unknown as { __sawRootBeforeDynamic?: boolean };
      state.__sawRootBeforeDynamic = false;
      new MutationObserver(() => {
        if (
          document.querySelector(".separate-root-static") &&
          !document.querySelector(".slow-dynamic-content")
        ) {
          state.__sawRootBeforeDynamic = true;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${BASE}/dynamic-no-loading-root`);

    await expect(page.locator(".slow-dynamic-content").first()).toHaveText(
      "Loaded in separate root",
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { __sawRootBeforeDynamic?: boolean }).__sawRootBeforeDynamic,
      ),
    ).toBe(true);
  });
});
