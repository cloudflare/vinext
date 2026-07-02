import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import type { PrefetchCacheEntry } from "vinext/shims/navigation";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/prefetch-layout-sharing";

function isRscRequestForPath(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return (
    url.pathname === pathname && url.searchParams.has("_rsc") && request.headers()["rsc"] === "1"
  );
}

function isRscResponseForPath(response: Response, pathname: string): boolean {
  return isRscRequestForPath(response.request(), pathname);
}

async function triggerAndReadRscResponses(
  page: Page,
  pathname: string,
  trigger: () => Promise<void>,
): Promise<{
  body: string;
  responses: {
    body: string;
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
    url: string;
  }[];
}> {
  const responses: Response[] = [];
  const onResponse = (response: Response) => {
    if (isRscResponseForPath(response, pathname)) {
      responses.push(response);
    }
  };

  page.on("response", onResponse);
  await trigger();
  await expect.poll(() => responses.length).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  page.off("response", onResponse);

  const capturedResponses = await Promise.all(
    responses.map(async (response) => ({
      body: await response.text(),
      requestHeaders: response.request().headers(),
      responseHeaders: response.headers(),
      url: response.url(),
    })),
  );

  return {
    body: capturedResponses.map((response) => response.body).join("\n"),
    responses: capturedResponses,
  };
}

test.describe("Next.js compat: prefetch layout sharing", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  test("revealed App Router full-prefetch links start prefetching before browser idle callbacks", async ({
    baseURL,
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "requestIdleCallback", {
        configurable: true,
        value() {
          return 1;
        },
      });
    });

    const requests: string[] = [];
    page.on("request", (request) => {
      if (isRscRequestForPath(request, `${ROOT}/shared-layout/one`)) {
        requests.push(request.url());
      }
    });

    await page.goto(`${baseURL}${ROOT}`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#prefetch-layout-sharing-home")).toBeVisible();

    await page.locator("#prefetch-layout-sharing-one-toggle").click();

    await expect.poll(() => requests.length).toBeGreaterThan(0);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  test("full prefetches can omit an already-prefetched shared layout and still navigate from cache", async ({
    baseURL,
    page,
  }) => {
    const rscRequestsAfterClick: string[] = [];
    page.on("request", (request) => {
      if (request.headers()["rsc"] === "1") {
        rscRequestsAfterClick.push(request.url());
      }
    });

    await page.goto(`${baseURL}${ROOT}`);
    await waitForAppRouterHydration(page);

    const oneResponse = await triggerAndReadRscResponses(page, `${ROOT}/shared-layout/one`, () =>
      page.locator("#prefetch-layout-sharing-one-toggle").click(),
    );
    expect(oneResponse.body).toContain("Dynamic content from layout");
    expect(oneResponse.body).toContain('"children":["workUnitStore.type: ","request"]');
    expect(oneResponse.body).toContain("Dynamic content from page one");

    const twoResponse = await triggerAndReadRscResponses(page, `${ROOT}/shared-layout/two`, () =>
      page.locator("#prefetch-layout-sharing-two-toggle").click(),
    );
    expect(twoResponse.body).not.toContain("Dynamic content from layout");
    expect(twoResponse.body).toContain("Dynamic content from page two");
    expect(
      twoResponse.responses
        .map((response) => response.responseHeaders["x-vinext-rsc-layout-ids"] ?? "")
        .join(" "),
    ).not.toContain(`layout:${ROOT}/shared-layout`);

    rscRequestsAfterClick.length = 0;
    await page.locator("#prefetch-layout-sharing-two-link").click();

    await expect(page.locator("h2")).toHaveText("Shared layout");
    await expect(page.locator("#work-unit-store-type")).toHaveText("workUnitStore.type: request");
    await expect(page.locator("h1")).toHaveText("Page two");
    await expect(page.locator("#dynamic-content-layout")).toHaveText("Dynamic content from layout");
    await expect(page.locator("#dynamic-content-page")).toHaveText("Dynamic content from page two");
    expect(rscRequestsAfterClick).toEqual([]);
  });

  test("full prefetch falls back when the retained shared layout source is evicted before click", async ({
    baseURL,
    page,
  }) => {
    await page.goto(`${baseURL}${ROOT}`);
    await waitForAppRouterHydration(page);

    const oneResponse = await triggerAndReadRscResponses(page, `${ROOT}/shared-layout/one`, () =>
      page.locator("#prefetch-layout-sharing-one-toggle").click(),
    );
    expect(oneResponse.body).toContain("Dynamic content from layout");

    const twoResponse = await triggerAndReadRscResponses(page, `${ROOT}/shared-layout/two`, () =>
      page.locator("#prefetch-layout-sharing-two-toggle").click(),
    );
    expect(twoResponse.body).not.toContain("Dynamic content from layout");
    expect(twoResponse.body).toContain("Dynamic content from page two");

    await page.waitForFunction((root) => {
      const vinextWindow = window as typeof window & {
        __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, PrefetchCacheEntry>;
      };
      const keys = [...(vinextWindow.__VINEXT_RSC_PREFETCH_CACHE__?.keys() ?? [])].map(String);
      return (
        keys.some((key) => key.includes(`${root}/shared-layout/one`)) &&
        keys.some((key) => key.includes(`${root}/shared-layout/two`))
      );
    }, ROOT);

    await page.evaluate((root) => {
      const vinextWindow = window as typeof window & {
        __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, PrefetchCacheEntry>;
        __VINEXT_RSC_PREFETCHED_URLS__?: Set<string>;
      };
      const cache = new Map<string, PrefetchCacheEntry>(
        vinextWindow.__VINEXT_RSC_PREFETCH_CACHE__ ?? [],
      );
      const prefetched = (vinextWindow.__VINEXT_RSC_PREFETCHED_URLS__ ??= new Set<string>());
      const pressureKey = `${root}/__vinext-test-pressure.rsc`;
      cache.set(pressureKey, {
        outcome: "cache-seeded",
        snapshot: {
          buffer: new ArrayBuffer(51 * 1024 * 1024),
          contentType: "text/x-component",
          mountedSlotsHeader: null,
          paramsHeader: null,
          url: pressureKey,
        },
        timestamp: Date.now(),
      });
      vinextWindow.__VINEXT_RSC_PREFETCH_CACHE__ = cache;
      prefetched.add(pressureKey);
      const router = (
        window as typeof window & {
          next?: { router?: { prefetch?: (href: string) => void } };
        }
      ).next?.router;
      if (!router || typeof router.prefetch !== "function") {
        throw new Error("window.next.router.prefetch is not installed");
      }
      router.prefetch(`${root}/dynamic-layout/a`);
    }, ROOT);

    await page.waitForFunction((root) => {
      const vinextWindow = window as typeof window & {
        __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, PrefetchCacheEntry>;
      };
      const keys = [...(vinextWindow.__VINEXT_RSC_PREFETCH_CACHE__?.keys() ?? [])].map(String);
      return (
        !keys.some((key) => key.includes(`${root}/shared-layout/one`)) &&
        !keys.some((key) => key.includes(`${root}/shared-layout/two`))
      );
    }, ROOT);

    const rscRequestsAfterClick: string[] = [];
    page.on("request", (request) => {
      if (isRscRequestForPath(request, `${ROOT}/shared-layout/two`)) {
        rscRequestsAfterClick.push(request.url());
      }
    });

    await page.locator("#prefetch-layout-sharing-two-link").click();

    await expect(page.locator("h2")).toHaveText("Shared layout");
    await expect(page.locator("#work-unit-store-type")).toHaveText("workUnitStore.type: request");
    await expect(page.locator("h1")).toHaveText("Page two");
    await expect(page.locator("#dynamic-content-layout")).toHaveText("Dynamic content from layout");
    await expect(page.locator("#dynamic-content-page")).toHaveText("Dynamic content from page two");
    await expect.poll(() => rscRequestsAfterClick.length).toBeGreaterThan(0);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  test("navigations can omit an already-prefetched shared layout after an auto prefetch", async ({
    baseURL,
    page,
  }) => {
    await page.goto(`${baseURL}${ROOT}`);
    await waitForAppRouterHydration(page);

    const oneResponse = await triggerAndReadRscResponses(page, `${ROOT}/shared-layout/one`, () =>
      page.locator("#prefetch-layout-sharing-one-toggle").click(),
    );
    expect(oneResponse.body).toContain("Dynamic content from page one");

    const autoPrefetchResponse = await triggerAndReadRscResponses(
      page,
      `${ROOT}/shared-layout/two`,
      () => page.locator("#prefetch-layout-sharing-two-auto-toggle").click(),
    );
    expect(autoPrefetchResponse.body).not.toContain("Dynamic content from layout");

    const navigationResponse = await triggerAndReadRscResponses(
      page,
      `${ROOT}/shared-layout/two`,
      () => page.locator("#prefetch-layout-sharing-two-auto-link").click(),
    );
    expect(navigationResponse.body).not.toContain("Dynamic content from layout");
    expect(navigationResponse.body).toContain("Dynamic content from page two");

    await expect(page.locator("h2")).toHaveText("Shared layout");
    await expect(page.locator("#work-unit-store-type")).toHaveText("workUnitStore.type: request");
    await expect(page.locator("h1")).toHaveText("Page two");
    await expect(page.locator("#dynamic-content-layout")).toHaveText("Dynamic content from layout");
    await expect(page.locator("#dynamic-content-page")).toHaveText("Dynamic content from page two");
  });

  // Ported from Next.js segment-cache identity rules:
  // packages/next/src/client/components/segment-cache/vary-path.ts
  // test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
  test("retained full-prefetch layouts are not reused across dynamic segment params", async ({
    baseURL,
    page,
  }) => {
    await page.goto(`${baseURL}${ROOT}`);
    await waitForAppRouterHydration(page);

    const firstResponse = await triggerAndReadRscResponses(page, `${ROOT}/dynamic-layout/a`, () =>
      page.locator("#prefetch-layout-sharing-dynamic-a-toggle").click(),
    );
    expect(firstResponse.body).toContain('"children":["Dynamic layout slug: ","a"]');
    expect(firstResponse.body).toContain('"children":["Dynamic page slug: ","a"]');

    const secondResponse = await triggerAndReadRscResponses(page, `${ROOT}/dynamic-layout/b`, () =>
      page.locator("#prefetch-layout-sharing-dynamic-b-toggle").click(),
    );
    expect(secondResponse.body).toContain('"children":["Dynamic layout slug: ","b"]');
    expect(secondResponse.body).toContain('"children":["Dynamic page slug: ","b"]');
    expect(
      secondResponse.responses
        .map((response) => response.requestHeaders["x-vinext-retained-prefetch-layouts"] ?? "")
        .join(" "),
    ).not.toContain(`layout:${ROOT}/dynamic-layout/[slug]`);
  });
});
