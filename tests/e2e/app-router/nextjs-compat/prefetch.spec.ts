/**
 * Next.js Compat E2E: app-prefetch (browser tests)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch/prefetching.test.ts
 *
 * Tests Link prefetching and navigation behavior.
 */

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

type PrefetchTestState = {
  fetchUrls: string[];
  requestIdleCallbackCalls: number;
};

type PendingPrefetchReuseState = {
  releasePrefetch: (() => void) | null;
  targetNavigationRequests: number;
  targetPrefetchRequests: number;
};

type PrefetchTestWindow = Window & {
  __VINEXT_PREFETCH_TEST__?: PrefetchTestState;
  __VINEXT_PENDING_PREFETCH_REUSE_TEST__?: PendingPrefetchReuseState;
  next?: {
    router?: {
      prefetch(href: string): void;
    };
  };
};

test.describe("Next.js compat: prefetch (browser)", () => {
  // Next.js: 'should navigate when prefetch is false'
  test("should navigate when prefetch is false", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    // Click the no-prefetch link
    await page.click("#no-prefetch-link");
    await expect(page.locator("#no-prefetch-target")).toHaveText("No Prefetch Target Page", {
      timeout: 10_000,
    });
  });

  // Test that prefetched link navigates correctly
  test("should navigate via prefetched link", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    // Click the prefetch link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });
  });

  // Test that prefetched navigation preserves client state (no full reload)
  test("prefetched navigation does not cause full page reload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    // Set marker to detect full reload
    await page.evaluate(() => {
      (window as any).__PREFETCH_MARKER__ = true;
    });

    // Navigate via prefetched link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });

    // Marker should survive (no full reload)
    const marker = await page.evaluate(() => (window as any).__PREFETCH_MARKER__);
    expect(marker).toBe(true);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts
  test("navigation reuses an in-flight RSC prefetch without a duplicate request", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const testWindow: PrefetchTestWindow = window;
      const originalFetch = window.fetch.bind(window);
      const state: PendingPrefetchReuseState = {
        releasePrefetch: null,
        targetNavigationRequests: 0,
        targetPrefetchRequests: 0,
      };
      testWindow.__VINEXT_PENDING_PREFETCH_REUSE_TEST__ = state;

      window.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.includes("/nextjs-compat/prefetch-test/target.rsc")) {
          if (state.targetPrefetchRequests === 0) {
            state.targetPrefetchRequests += 1;
            await new Promise<void>((resolve) => {
              state.releasePrefetch = resolve;
            });
          } else {
            state.targetNavigationRequests += 1;
          }
        }

        return originalFetch(input, init);
      };
    });

    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    await page.evaluate(() => {
      const router = (window as PrefetchTestWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch("/nextjs-compat/prefetch-test/target");
    });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
          if (state === undefined) throw new Error("Missing pending prefetch test state");
          return state.targetPrefetchRequests;
        }),
      )
      .toBe(1);

    await page.click("#prefetch-link");

    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    expect(
      await page.evaluate(() => {
        const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
        if (state === undefined) throw new Error("Missing pending prefetch test state");
        return state.targetNavigationRequests;
      }),
    ).toBe(0);

    await page.evaluate(() => {
      const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
      if (state?.releasePrefetch === null || state?.releasePrefetch === undefined) {
        throw new Error("Target prefetch was not blocked");
      }
      state.releasePrefetch();
    });

    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });
    expect(
      await page.evaluate(() => {
        const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
        if (state === undefined) throw new Error("Missing pending prefetch test state");
        return state.targetNavigationRequests;
      }),
    ).toBe(0);
  });

  test("Link with prefetch={false} does not prefetch RSC payload in dev", async ({ page }) => {
    await page.addInitScript(() => {
      const testWindow: PrefetchTestWindow = window;
      const originalFetch = window.fetch.bind(window);
      const originalRequestIdleCallback = window.requestIdleCallback?.bind(window);
      const state: PrefetchTestState = {
        fetchUrls: [],
        requestIdleCallbackCalls: 0,
      };
      testWindow.__VINEXT_PREFETCH_TEST__ = state;
      window.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(".rsc")) {
          state.fetchUrls.push(url);
        }
        return originalFetch(input, init);
      };
      window.requestIdleCallback = (callback, options) => {
        state.requestIdleCallbackCalls += 1;
        if (originalRequestIdleCallback) {
          return originalRequestIdleCallback(callback, options);
        }
        return window.setTimeout(() => {
          callback({
            didTimeout: false,
            timeRemaining: () => 50,
          });
        }, 1);
      };
    });

    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    // Verify the fetch instrumentation sees .rsc URLs before relying on it
    // to assert that Link prefetch does not issue a no-prefetch request.
    await page.evaluate(async () => {
      await window.fetch("/nextjs-compat/prefetch-test/target.rsc");
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const testWindow: PrefetchTestWindow = window;
          const state = testWindow.__VINEXT_PREFETCH_TEST__;
          if (state === undefined) throw new Error("Missing prefetch test instrumentation");
          return state.fetchUrls.some((url) => url.includes("target.rsc"));
        }),
      )
      .toBe(true);

    await page.evaluate(() => {
      const testWindow: PrefetchTestWindow = window;
      const state = testWindow.__VINEXT_PREFETCH_TEST__;
      if (state === undefined) throw new Error("Missing prefetch test instrumentation");
      state.fetchUrls = [];
      state.requestIdleCallbackCalls = 0;
    });

    await page.hover("#no-prefetch-link");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    const diagnostics = await page.evaluate(() => {
      const testWindow: PrefetchTestWindow = window;
      const state = testWindow.__VINEXT_PREFETCH_TEST__;
      if (state === undefined) throw new Error("Missing prefetch test instrumentation");
      return {
        fetchUrls: state.fetchUrls,
        requestIdleCallbackCalls: state.requestIdleCallbackCalls,
      };
    });
    expect(diagnostics.fetchUrls.some((url) => url.includes("no-prefetch.rsc"))).toBe(false);
    expect(diagnostics.requestIdleCallbackCalls).toBe(0);
  });
});
