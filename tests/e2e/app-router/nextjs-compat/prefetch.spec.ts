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
  loadingShellResponseText?: string;
  prefetchHeaders?: Record<string, string>;
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
  test("does not treat a partial router prefetch as full across a parallel layout", async ({
    page,
  }) => {
    const clientCachePath = "/nextjs-compat/client-cache";
    const rscRequests: Array<{ pathname: string; prefetch: string | undefined }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
      rscRequests.push({
        pathname: url.pathname,
        prefetch: request.headers()["next-router-prefetch"],
      });
    });

    await page.goto(`${BASE}${clientCachePath}`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#client-cache-home")).toBeVisible();
    await page.evaluate((href) => {
      const router = (window as PrefetchTestWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(href);
    }, `${clientCachePath}/0`);
    await expect
      .poll(() =>
        rscRequests.some(
          (request) => request.pathname === `${clientCachePath}/0` && request.prefetch === "1",
        ),
      )
      .toBe(true);

    rscRequests.length = 0;
    await page.click("#client-cache-full");
    await expect(page.locator("#client-cache-id")).toHaveText("0");
    expect(
      rscRequests.some(
        (request) => request.pathname === `${clientCachePath}/0` && request.prefetch === undefined,
      ),
    ).toBe(true);
  });

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

  test("normal router prefetch sends router state and reaches loading-shell rendering", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForAppRouterHydration(page);

    const programmaticTarget =
      "/nextjs-compat/prefetch-test/programmatic-target?prefetch-source=router-prefetch-protocol";
    const prefetchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/nextjs-compat/prefetch-test/programmatic-target" &&
        url.searchParams.get("prefetch-source") === "router-prefetch-protocol" &&
        url.searchParams.has("_rsc")
      );
    });
    await page.evaluate((target) => {
      const router = (window as PrefetchTestWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(target);
    }, programmaticTarget);

    const response = await prefetchResponse;
    const headers = await response.request().allHeaders();
    expect(headers["next-router-prefetch"]).toBe("1");
    expect(headers["next-url"]).toBe("/nextjs-compat/prefetch-test");
    expect(headers["next-router-state-tree"]).toBeTruthy();
    expect(await response.text()).toContain("Loading programmatic prefetch target");
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
  test("navigation does not consume an in-flight partial prefetch as a full payload", async ({
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
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(rawUrl, window.location.href);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => {
            headers.set(key, value);
          });
        }

        if (
          url.pathname === "/nextjs-compat/prefetch-test/programmatic-target" &&
          url.searchParams.has("_rsc") &&
          headers.get("rsc") === "1"
        ) {
          if (headers.get("next-router-prefetch") === "1") {
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
      router.prefetch("/nextjs-compat/prefetch-test/programmatic-target");
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

    await page.evaluate(() => {
      const router = (window as PrefetchTestWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      void router.push("/nextjs-compat/prefetch-test/programmatic-target");
    });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
          if (state === undefined) throw new Error("Missing pending prefetch test state");
          return state.targetNavigationRequests;
        }),
      )
      .toBe(1);

    await expect(page.getByRole("heading", { name: "Programmatic Prefetch Target" })).toBeVisible({
      timeout: 10_000,
    });

    await page.evaluate(() => {
      const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
      if (state?.releasePrefetch === null || state?.releasePrefetch === undefined) {
        throw new Error("Target prefetch was not blocked");
      }
      state.releasePrefetch();
    });

    expect(
      await page.evaluate(() => {
        const state = (window as PrefetchTestWindow).__VINEXT_PENDING_PREFETCH_REUSE_TEST__;
        if (state === undefined) throw new Error("Missing pending prefetch test state");
        return state.targetNavigationRequests;
      }),
    ).toBe(1);
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
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(rawUrl, window.location.href);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => {
            headers.set(key, value);
          });
        }

        if (url.searchParams.has("_rsc") && headers.get("rsc") === "1") {
          state.fetchUrls.push(url.href);
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

    // Verify the fetch instrumentation sees canonical RSC URLs before relying on it
    // to assert that Link prefetch does not issue a no-prefetch request.
    await page.evaluate(async () => {
      await window.fetch("/nextjs-compat/prefetch-test/target?_rsc", {
        headers: { Accept: "text/x-component", RSC: "1" },
      });
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const testWindow: PrefetchTestWindow = window;
          const state = testWindow.__VINEXT_PREFETCH_TEST__;
          if (state === undefined) throw new Error("Missing prefetch test instrumentation");
          return state.fetchUrls.some((url) => {
            const parsed = new URL(url);
            return (
              parsed.pathname === "/nextjs-compat/prefetch-test/target" &&
              parsed.searchParams.has("_rsc")
            );
          });
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
    expect(
      diagnostics.fetchUrls.some((url) => {
        const parsed = new URL(url);
        return (
          parsed.pathname === "/nextjs-compat/prefetch-test/no-prefetch" &&
          parsed.searchParams.has("_rsc")
        );
      }),
    ).toBe(false);
    expect(diagnostics.requestIdleCallbackCalls).toBe(0);
  });
});
