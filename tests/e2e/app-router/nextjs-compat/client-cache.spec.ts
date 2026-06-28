/**
 * Next.js Compat E2E: App Router client cache semantics.
 *
 * Ported from Next.js:
 * test/e2e/app-dir/app-client-cache/client-cache.original.test.ts
 * test/e2e/app-dir/app-client-cache/client-cache.parallel-routes.test.ts
 * https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/app-client-cache
 */

import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/client-cache";

type RscRequest = {
  partial: boolean;
  pathname: string;
};

type DelayedNavigationCachePublicationState = {
  releaseOldNavigationTail: (() => void) | null;
};

type ClientCacheTestWindow = Window & {
  __VINEXT_DELAYED_NAVIGATION_CACHE_PUBLICATION__?: DelayedNavigationCachePublicationState;
  next?: {
    router?: {
      refresh(): void;
    };
  };
};

async function installFixedTime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeDate = Date;
    let now = NativeDate.parse("2023-04-17T00:00:00Z");

    class FixedDate extends NativeDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(now);
        } else {
          super(args[0] as string | number | Date);
        }
      }

      static now() {
        return now;
      }
    }

    Object.defineProperty(window, "__VINEXT_CLIENT_CACHE_ADVANCE_TIME__", {
      value(ms: number) {
        now += ms;
      },
    });
    window.Date = FixedDate as DateConstructor;
  });
}

async function advanceTime(page: Page, ms: number): Promise<void> {
  await page.evaluate((duration) => {
    const advance = Reflect.get(window, "__VINEXT_CLIENT_CACHE_ADVANCE_TIME__");
    if (typeof advance !== "function") throw new Error("Fixed clock is not installed");
    advance(duration);
  }, ms);
}

function trackRscRequests(page: Page): RscRequest[] {
  const requests: RscRequest[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    requests.push({
      partial: request.headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell",
      pathname: url.pathname,
    });
  });
  return requests;
}

async function openHome(page: Page): Promise<void> {
  await page.goto(ROOT);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#client-cache-home")).toBeVisible();
}

async function readRandom(page: Page): Promise<string> {
  return page.locator("#client-cache-random").innerText();
}

async function navigateHome(page: Page): Promise<void> {
  await page.click("#client-cache-back");
  await expect(page.locator("#client-cache-home")).toBeVisible();
}

async function navigateTo(page: Page, selector: string, id: string): Promise<string> {
  await page.click(selector);
  await expect(page.locator("#client-cache-id")).toHaveText(id);
  return readRandom(page);
}

function requestsFor(requests: RscRequest[], pathname: string): RscRequest[] {
  return requests.filter((request) => request.pathname === pathname);
}

test.describe("Next.js compat: client cache", () => {
  test.beforeEach(async ({ page }) => {
    await installFixedTime(page);
  });

  test("auto partial prefetch promotes to a committed full payload and reuses it", async ({
    page,
  }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    await page.hover("#client-cache-auto");

    await expect
      .poll(() => requestsFor(requests, `${ROOT}/1`).some((request) => request.partial))
      .toBe(true);

    requests.length = 0;
    const initial = await navigateTo(page, "#client-cache-auto", "1");
    expect(requestsFor(requests, `${ROOT}/1`).some((request) => !request.partial)).toBe(true);

    await navigateHome(page);
    await advanceTime(page, 5_000);
    requests.length = 0;
    const reused = await navigateTo(page, "#client-cache-auto", "1");
    expect(reused).toBe(initial);
    expect(requestsFor(requests, `${ROOT}/1`)).toEqual([]);
  });

  test("hovering prefetch={false} emits zero requests", async ({ page }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    requests.length = 0;

    await page.hover("#client-cache-none");
    await page.waitForTimeout(250);

    expect(requestsFor(requests, `${ROOT}/2`)).toEqual([]);
  });

  test("auto cache expires after 30s and renews its TTL after revalidation", async ({ page }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    const initial = await navigateTo(page, "#client-cache-auto", "1");

    await navigateHome(page);
    await advanceTime(page, 30_001);
    requests.length = 0;
    const renewed = await navigateTo(page, "#client-cache-auto", "1");
    expect(renewed).not.toBe(initial);
    expect(requestsFor(requests, `${ROOT}/1`).some((request) => !request.partial)).toBe(true);

    await navigateHome(page);
    await advanceTime(page, 5_000);
    requests.length = 0;
    expect(await navigateTo(page, "#client-cache-auto", "1")).toBe(renewed);
    expect(requestsFor(requests, `${ROOT}/1`)).toEqual([]);
  });

  test("parallel-slot state changes independently and the full payload remains reusable", async ({
    page,
  }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText("Root Breadcrumb");
    await page.hover("#client-cache-full");

    await expect
      .poll(() => requestsFor(requests, `${ROOT}/0`).some((request) => !request.partial))
      .toBe(true);
    expect(requestsFor(requests, `${ROOT}/0`).some((request) => request.partial)).toBe(false);

    requests.length = 0;
    const initial = await navigateTo(page, "#client-cache-full", "0");
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText('Catchall {"id":"0"}');
    expect(requestsFor(requests, `${ROOT}/0`)).toEqual([]);

    await navigateHome(page);
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText("Root Breadcrumb");
    requests.length = 0;
    const reused = await navigateTo(page, "#client-cache-full", "0");
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText('Catchall {"id":"0"}');
    expect(reused).toBe(initial);
    expect(requestsFor(requests, `${ROOT}/0`)).toEqual([]);
  });

  test("initial hydration seeds the visited cache for later client navigation", async ({
    page,
  }) => {
    const requests = trackRscRequests(page);
    await page.goto(`${ROOT}/2`);
    await waitForAppRouterHydration(page);
    const initial = await readRandom(page);

    await navigateHome(page);
    requests.length = 0;
    expect(await navigateTo(page, "#client-cache-none", "2")).toBe(initial);
    expect(requestsFor(requests, `${ROOT}/2`)).toEqual([]);
  });

  test("back and forward restore the committed client cache payload", async ({ page }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    const initial = await navigateTo(page, "#client-cache-none", "2");

    await page.goBack();
    await expect(page.locator("#client-cache-home")).toBeVisible();
    requests.length = 0;
    await page.goForward();
    await expect(page.locator("#client-cache-id")).toHaveText("2");
    expect(await readRandom(page)).toBe(initial);
    expect(requestsFor(requests, `${ROOT}/2`)).toEqual([]);
  });

  test("router refresh invalidates committed client cache payloads", async ({ page }) => {
    const requests = trackRscRequests(page);
    await openHome(page);
    const initial = await navigateTo(page, "#client-cache-none", "2");
    await navigateHome(page);

    await page.click("#client-cache-invalidate");
    await expect
      .poll(() => requestsFor(requests, ROOT).some((request) => !request.partial))
      .toBe(true);

    requests.length = 0;
    const refreshed = await navigateTo(page, "#client-cache-none", "2");
    expect(refreshed).not.toBe(initial);
    expect(requestsFor(requests, `${ROOT}/2`).some((request) => !request.partial)).toBe(true);
  });

  test("a navigation tail cannot republish after refresh invalidates its cache generation", async ({
    page,
  }) => {
    await page.addInitScript((targetPath) => {
      const testWindow = window as ClientCacheTestWindow;
      const originalFetch = window.fetch.bind(window);
      const state: DelayedNavigationCachePublicationState = {
        releaseOldNavigationTail: null,
      };
      testWindow.__VINEXT_DELAYED_NAVIGATION_CACHE_PUBLICATION__ = state;

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

        const response = await originalFetch(input, init);
        if (
          state.releaseOldNavigationTail !== null ||
          url.pathname !== targetPath ||
          !url.searchParams.has("_rsc") ||
          headers.get("rsc") !== "1" ||
          response.body === null
        ) {
          return response;
        }

        const targetBody = response.body;
        const originalTee = targetBody.tee.bind(targetBody);
        targetBody.tee = function () {
          const [reactBranch, cacheBranch] = originalTee();
          const cacheReader = cacheBranch.getReader();
          const delayedCacheBranch = new ReadableStream<Uint8Array<ArrayBuffer>>({
            async start(controller) {
              while (true) {
                const result = await cacheReader.read();
                if (result.done) break;
                controller.enqueue(result.value);
              }
              await new Promise<void>((resolve) => {
                state.releaseOldNavigationTail = resolve;
              });
              controller.close();
            },
            cancel(reason) {
              return cacheReader.cancel(reason);
            },
          });
          return [reactBranch, delayedCacheBranch];
        };
        return response;
      };
    }, `${ROOT}/2`);

    const requests = trackRscRequests(page);
    await openHome(page);
    const initial = await navigateTo(page, "#client-cache-none", "2");

    await page.evaluate(() => {
      const router = (window as ClientCacheTestWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.refresh();
    });
    await expect
      .poll(() => requestsFor(requests, `${ROOT}/2`).filter((request) => !request.partial).length)
      .toBeGreaterThanOrEqual(2);
    await expect.poll(() => readRandom(page)).not.toBe(initial);
    const refreshed = await readRandom(page);

    await page.evaluate(() => {
      const state = (window as ClientCacheTestWindow)
        .__VINEXT_DELAYED_NAVIGATION_CACHE_PUBLICATION__;
      if (
        state?.releaseOldNavigationTail === null ||
        state?.releaseOldNavigationTail === undefined
      ) {
        throw new Error("Old navigation tail was not delayed");
      }
      state.releaseOldNavigationTail();
    });
    await navigateHome(page);
    requests.length = 0;

    expect(await navigateTo(page, "#client-cache-none", "2")).toBe(refreshed);
    expect(requestsFor(requests, `${ROOT}/2`)).toEqual([]);
  });
});
