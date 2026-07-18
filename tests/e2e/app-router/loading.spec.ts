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
