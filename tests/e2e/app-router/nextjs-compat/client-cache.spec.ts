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
});
