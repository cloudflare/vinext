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
  __VINEXT_CLIENT_CACHE_TEE_COUNT__?: () => number;
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

  test("committed no-prefetch navigations publish cache snapshots after immediate back", async ({
    page,
  }) => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
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
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText('Catchall {"id":"2"}');
    await navigateHome(page);

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

    await page.evaluate(() => {
      const testWindow = window as ClientCacheTestWindow;
      let teeCount = 0;
      const originalTee = Reflect.get(
        ReadableStream.prototype,
        "tee",
      ) as typeof ReadableStream.prototype.tee;
      ReadableStream.prototype.tee = function (this: ReadableStream<unknown>) {
        teeCount += 1;
        return originalTee.call(this);
      } as typeof ReadableStream.prototype.tee;
      testWindow.__VINEXT_CLIENT_CACHE_TEE_COUNT__ = () => teeCount;
    });

    requests.length = 0;
    expect(await navigateTo(page, "#client-cache-none", "2")).toBe(initial);
    await expect(page.locator("#client-cache-breadcrumbs")).toHaveText('Catchall {"id":"2"}');
    expect(requestsFor(requests, `${ROOT}/2`)).toEqual([]);
    expect(
      await page.evaluate(() => {
        const readTeeCount = (window as ClientCacheTestWindow).__VINEXT_CLIENT_CACHE_TEE_COUNT__;
        if (readTeeCount === undefined) throw new Error("ReadableStream.tee counter missing");
        return readTeeCount();
      }),
    ).toBe(0);
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

test("ISR hydration uses the current visitor's search params", async ({ page, request }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") hydrationErrors.push(message.text());
  });
  page.on("pageerror", (error) => hydrationErrors.push(error.message));

  const slug = `hydration-query-${Date.now()}`;
  const pathname = `/isr-client-search-poison/${slug}`;

  const attackerResponse = await request.get(`${pathname}?q=ATTACKER_PAYLOAD`);
  expect(attackerResponse.status()).toBe(200);
  const attackerHtml = await attackerResponse.text();
  expect(attackerHtml).toContain("loading");
  expect(attackerHtml).not.toContain("ATTACKER_PAYLOAD");

  await page.waitForTimeout(100);

  const victimResponse = await page.goto(pathname);
  expect(victimResponse?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("query-echo")).toHaveText("Search query: none");

  const otherVictimResponse = await page.goto(`${pathname}?q=INNOCENT_PAYLOAD`);
  expect(otherVictimResponse?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("query-echo")).toHaveText("Search query: INNOCENT_PAYLOAD");
  await expect(page.locator("body")).not.toContainText("ATTACKER_PAYLOAD");
  expect(hydrationErrors).toEqual([]);
});

test("force-static hydration reads search params from the current URL", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") hydrationErrors.push(message.text());
  });
  page.on("pageerror", (error) => hydrationErrors.push(error.message));

  const pathname = "/isr-client-search-force-static";

  const firstResponse = await page.goto(`${pathname}?q=FIRST_QUERY`);
  expect(firstResponse?.status()).toBe(200);
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("force-static-query-echo")).toHaveText(
    "Force-static query: FIRST_QUERY",
  );

  const secondResponse = await page.goto(`${pathname}?q=SECOND_QUERY`);
  expect(secondResponse?.status()).toBe(200);
  expect(secondResponse?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("force-static-query-echo")).toHaveText(
    "Force-static query: SECOND_QUERY",
  );
  await expect(page.locator("body")).not.toContainText("FIRST_QUERY");
  expect(hydrationErrors).toEqual([]);
});

// Next.js confirms useSearchParams wrapped in Suspense must retain a static shell:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/missing-suspense-with-csr-bailout/missing-suspense-with-csr-bailout.test.ts
test("dynamic-error client search params bail out to cached Suspense HTML", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") hydrationErrors.push(message.text());
  });
  page.on("pageerror", (error) => hydrationErrors.push(error.message));

  const slug = `dynamic-error-hydration-${Date.now()}`;
  const pathname = `/isr-client-search-dynamic-error/${slug}`;

  const firstResponse = await page.goto(`${pathname}?q=FIRST_QUERY`);
  expect(firstResponse?.status()).toBe(200);
  const firstHtml = await firstResponse?.text();
  expect(firstHtml).toContain("loading");
  expect(firstHtml).not.toContain("FIRST_QUERY");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("dynamic-error-query-echo")).toHaveText(
    "Dynamic-error query: FIRST_QUERY",
  );

  await page.waitForTimeout(1_100);

  const secondResponse = await page.goto(`${pathname}?q=SECOND_QUERY`);
  expect(secondResponse?.status()).toBe(200);
  expect(secondResponse?.headers()["x-vinext-cache"]).toBe("STALE");
  const secondHtml = await secondResponse?.text();
  expect(secondHtml).toContain("loading");
  expect(secondHtml).not.toContain("SECOND_QUERY");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("dynamic-error-query-echo")).toHaveText(
    "Dynamic-error query: SECOND_QUERY",
  );
  await expect(page.locator("body")).not.toContainText("FIRST_QUERY");

  await expect
    .poll(
      async () => {
        const response = await page.request.get(pathname);
        return response.headers()["x-vinext-cache"];
      },
      { timeout: 10_000 },
    )
    .toBe("HIT");

  const thirdResponse = await page.goto(`${pathname}?q=THIRD_QUERY`);
  expect(thirdResponse?.status()).toBe(200);
  expect(thirdResponse?.headers()["x-vinext-cache"]).toBe("HIT");
  const thirdHtml = await thirdResponse?.text();
  expect(thirdHtml).toContain("loading");
  expect(thirdHtml).not.toContain("THIRD_QUERY");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("dynamic-error-query-echo")).toHaveText(
    "Dynamic-error query: THIRD_QUERY",
  );
  expect(hydrationErrors).toEqual([]);
});

test("unbounded dynamic-error client search params fail without a cache artifact", async ({
  request,
}) => {
  const slug = `unbounded-dynamic-error-${Date.now()}`;
  const pathname = `/isr-client-search-dynamic-error-unbounded/${slug}`;

  const first = await request.get(`${pathname}?q=UNBOUNDED_ATTACKER`);
  expect(first.status()).toBe(500);
  expect(await first.text()).not.toContain("UNBOUNDED_ATTACKER");

  const second = await request.get(pathname);
  expect(second.status()).toBe(500);
  expect(second.headers()["x-vinext-cache"]).not.toBe("HIT");
});

test("rewrite destination query is hidden from SSR client hooks", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") hydrationErrors.push(message.text());
  });
  page.on("pageerror", (error) => hydrationErrors.push(error.message));

  const response = await page.goto("/nextjs-compat/rewrite-query-visible?shown=yes");
  expect(response?.status()).toBe(200);
  const html = await response?.text();
  expect(html).toContain("server:shown=<!-- -->yes<!-- -->&amp;hidden=<!-- -->secret");
  expect(html).toContain("client:<!-- -->shown=yes");
  expect(html).not.toContain("client:<!-- -->shown=yes&amp;hidden=secret");

  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("rewrite-page-query")).toHaveText("server:shown=yes&hidden=secret");
  await expect(page.getByTestId("rewrite-client-query")).toHaveText("client:shown=yes");
  expect(hydrationErrors).toEqual([]);
});

test("server-inserted callback query access fails without cache publication", async ({
  request,
}) => {
  const slug = `inserted-dynamic-error-${Date.now()}`;
  const pathname = `/isr-client-search-inserted-error/${slug}`;

  const first = await request.get(`${pathname}?q=INSERTED_ATTACKER`);
  expect(first.status()).toBe(500);
  expect(await first.text()).not.toContain("INSERTED_ATTACKER");

  const second = await request.get(pathname);
  expect(second.status()).toBe(500);
  expect(second.headers()["x-vinext-cache"]).not.toBe("HIT");
});
