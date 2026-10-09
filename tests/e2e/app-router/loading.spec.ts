import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("Loading boundaries (loading.tsx)", () => {
  test("slow page eventually renders content", async ({ page }) => {
    await page.goto(`${BASE}/slow`);
    // The page should render — loading.tsx should resolve to the actual page
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
    await expect(page.locator("main > p")).toHaveText("This page has a loading boundary.");
  });

  test("slow page serves HTML response", async ({ page }) => {
    const response = await page.goto(`${BASE}/slow`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toContain("text/html");
  });

  /**
   * OpenNext Compat: loading.tsx Suspense visibility timing
   *
   * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/ssr.test.ts
   *
   * OpenNext verifies that loading.tsx boundary is visible BEFORE the page content
   * resolves. This confirms Suspense streaming works correctly — the loading state
   * is sent immediately in the initial HTML shell, then replaced by the resolved content.
   *
   * The slow page has a 2s async delay. The loading.tsx fallback should appear in
   * the initial streamed HTML shell before the page component resolves.
   */
  test("loading boundary is visible before content resolves", async ({ page }) => {
    // Ref: opennextjs-cloudflare ssr.test.ts "Server Side Render and loading.tsx"

    // Navigate to slow page — loading.tsx should show first due to 2s server delay
    void page.goto(`${BASE}/slow`);

    // loading.tsx fallback should appear quickly in the streamed shell
    const loading = page.locator("#loading-fallback");
    await expect(loading).toBeVisible({ timeout: 5_000 });

    // Then the actual page content should resolve
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  test("loading boundary streams when a sync server page suspends with use()", async ({ page }) => {
    void page.goto(`${BASE}/slow-use`);

    await expect(page.locator("#loading-use-fallback")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("h1")).toHaveText("Slow use() Page", {
      timeout: 10_000,
    });
  });

  test("ancestor loading boundary streams for a nested sync use() page", async ({ page }) => {
    void page.goto(`${BASE}/slow-use-ancestor/child`);

    await expect(page.locator("#loading-use-ancestor-fallback")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("h1")).toHaveText("Nested slow use() Page", {
      timeout: 10_000,
    });
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  test("slow nested layout streams its ancestor loading fallback before resolving", async () => {
    const streamFallback = async () => {
      const response = await fetch(`${BASE}/slow-layout-with-loading/slow`);
      if (!response.body) throw new Error("Expected a streaming response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "";
      try {
        while (!html.includes('id="slow-layout-loading"')) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Response ended before the loading fallback was streamed");
          html += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }
    };

    // Compile this route before starting the timing assertion. Vite's first
    // request can spend longer than the threshold transforming a new fixture;
    // the second request isolates server-render streaming from dev compilation.
    await streamFallback();
    await expect(
      Promise.race([
        streamFallback(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Loading fallback did not stream promptly")), 1_500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  test("ancestor loading-shell prefetch stops before the slow descendant layout", async () => {
    const fetchLoadingShell = () =>
      fetch(`${BASE}/slow-layout-with-loading/slow?_rsc=loading-shell`, {
        headers: {
          RSC: "1",
          "Next-Router-Prefetch": "1",
          "Next-Router-Segment-Prefetch": "1",
          "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
        },
      });

    // Warm the generated route before measuring request-time tree traversal.
    await (await fetchLoadingShell()).text();
    const startedAt = performance.now();
    const response = await fetchLoadingShell();
    const body = await response.text();
    const durationMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(durationMs).toBeLessThan(1_500);
    expect(body).toContain("Loading layout");
    expect(body).not.toContain("Slow layout resolved");
    expect(body).not.toContain("slow-layout-message");
  });

  test("client navigation uses an ancestor-only loading shell", async ({ page }) => {
    await page.goto(BASE);
    const link = page.getByTestId("slow-layout-with-loading-link");
    await link.waitFor();
    await page.waitForTimeout(250);

    await link.click();
    await expect(page.locator("#slow-layout-loading")).toBeVisible({ timeout: 1_500 });
    await expect(page.locator("#slow-layout-message")).toHaveText("Slow layout resolved", {
      timeout: 10_000,
    });
  });

  test("slot-only loading-shell prefetch stops before the slow slot page", async () => {
    const fetchLoadingShell = () =>
      fetch(`${BASE}/slow-slot-loading/slow?_rsc=slot-loading-shell`, {
        headers: {
          RSC: "1",
          "Next-Router-Prefetch": "1",
          "Next-Router-Segment-Prefetch": "1",
          "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
        },
      });

    await (await fetchLoadingShell()).text();
    const startedAt = performance.now();
    const response = await fetchLoadingShell();
    const body = await response.text();
    const durationMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(durationMs).toBeLessThan(1_500);
    expect(body).toContain("Loading named slot");
    expect(body).not.toContain("Slow named slot resolved");
  });

  test("client navigation streams a slot-only loading boundary", async ({ page }) => {
    await page.goto(BASE);
    const link = page.getByTestId("slow-slot-loading-link");
    await link.waitFor();
    await page.waitForTimeout(250);

    await link.click();
    await expect(page.locator("#slow-slot-loading")).toBeVisible({ timeout: 1_500 });
    await expect(page.locator("#slow-slot-message")).toHaveText("Slow named slot resolved", {
      timeout: 10_000,
    });
  });

  test("client interception streams its branch loading boundary", async ({ page }) => {
    await page.goto(`${BASE}/slow-intercept`);
    await waitForAppRouterHydration(page);
    const link = page.getByTestId("slow-intercept-link");
    await link.waitFor();

    await link.click();
    await expect(page.locator("#slow-intercept-loading")).toBeVisible({ timeout: 1_500 });
    await expect(page.locator("#slow-intercept-message")).toHaveText(
      "Slow intercepted photo resolved",
      { timeout: 10_000 },
    );
  });

  // Next.js renders a parent segment's loading.tsx around the child segment's
  // layout (layout-router.tsx's LoadingBoundary uses `parentLoadingData`), so
  // it never renders inside that layout. Regression for cloudflare/vinext#3725.
  test("ancestor loading above a shared layout keeps the current page during navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/ancestor-loading-shared-layout`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#ancestor-shared-layout-overview")).toBeVisible();

    await page.evaluate(() => {
      const state = window as unknown as { __sawAncestorSharedLayoutLoading?: boolean };
      state.__sawAncestorSharedLayoutLoading = false;
      new MutationObserver(() => {
        if (document.getElementById("ancestor-shared-layout-loading")) {
          state.__sawAncestorSharedLayoutLoading = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.locator("#ancestor-shared-layout-settings-link").click();
    // The settings page takes 1.5s; the overview and tabs stay on screen meanwhile.
    await page.waitForTimeout(500);
    await expect(page.locator("#ancestor-shared-layout-overview")).toBeVisible();
    await expect(page.locator("#ancestor-shared-layout-tabs")).toBeVisible();
    await expect(page.locator("#ancestor-shared-layout-settings")).toHaveText("Settings page", {
      timeout: 10_000,
    });

    const sawLoading = await page.evaluate(
      () =>
        (window as unknown as { __sawAncestorSharedLayoutLoading?: boolean })
          .__sawAncestorSharedLayoutLoading,
    );
    expect(sawLoading).toBe(false);
  });

  test("ancestor loading above a shared layout wraps that layout on first entry", async ({
    page,
  }) => {
    void page.goto(`${BASE}/ancestor-loading-shared-layout/settings`);

    await expect(page.locator("#ancestor-shared-layout-loading")).toBeVisible({ timeout: 5_000 });
    // The layout resolves after 100ms but the page takes 1.5s, so the loading
    // UI must still replace the layout rather than render inside its tabs.
    await page.waitForTimeout(600);
    await expect(page.locator("#ancestor-shared-layout-loading")).toBeVisible();
    await expect(page.locator("#ancestor-shared-layout-tabs")).toBeHidden();
    await expect(page.locator("#ancestor-shared-layout-settings")).toHaveText("Settings page", {
      timeout: 10_000,
    });
    await expect(page.locator("#ancestor-shared-layout-loading")).toHaveCount(0);
  });

  test("ancestor loading above a slot's owner layout wraps that layout on first entry", async ({
    page,
  }) => {
    void page.goto(`${BASE}/ancestor-loading-shared-layout/slotted`);

    await expect(page.locator("#ancestor-shared-layout-loading")).toBeVisible({ timeout: 5_000 });
    // The owner layout and its page render at once but the @panel slot takes
    // 1.5s, so the loading UI must replace the layout rather than the slot.
    await page.waitForTimeout(600);
    await expect(page.locator("#ancestor-shared-layout-loading")).toBeVisible();
    await expect(page.locator("#ancestor-shared-layout-slotted")).toBeHidden();
    await expect(page.locator("#ancestor-shared-layout-panel")).toHaveText("Panel slot", {
      timeout: 10_000,
    });
    await expect(page.locator("#ancestor-shared-layout-slotted-page")).toBeVisible();
    await expect(page.locator("#ancestor-shared-layout-loading")).toHaveCount(0);
  });

  test("slow nested layout and page include both loading fallbacks in initial HTML", async ({
    request,
  }) => {
    const response = await request.get(`${BASE}/slow-layout-and-page-with-loading/slow`);
    const html = await response.text();

    expect(response.status()).toBe(200);
    expect(html).toContain('id="slow-combined-layout-loading"');
    expect(html).toContain('id="slow-combined-page-loading"');
  });

  test("slow nested layout and page eventually render final content", async ({ page }) => {
    await page.goto(`${BASE}/slow-layout-and-page-with-loading/slow`);

    await expect(page.locator("#slow-combined-layout-message")).toHaveText("Slow layout resolved", {
      timeout: 10_000,
    });
    await expect(page.locator("#slow-combined-page-message")).toHaveText("Slow page resolved", {
      timeout: 10_000,
    });
  });
});
