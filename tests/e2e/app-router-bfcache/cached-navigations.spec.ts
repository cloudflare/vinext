import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "/nextjs-compat/cached-navigations";

function visibleId(page: Page, id: string) {
  return page.locator(`#${id}:visible`).first();
}

function visibleMain(page: Page) {
  return page.locator("main:visible").first();
}

async function expectVisibleIdText(page: Page, id: string, expected: string) {
  await expect
    .poll(async () =>
      visibleId(page, id).evaluate((element) =>
        element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""),
      ),
    )
    .toBe(expected);
}

async function expectVisibleMainNotToContain(page: Page, text: string) {
  await expect
    .poll(async () =>
      visibleMain(page).evaluate((element, expectedText) => {
        const renderedText =
          element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
        return renderedText.includes(expectedText);
      }, text),
    )
    .toBe(false);
}

async function clickLink(page: Page, href: string) {
  await page.locator(`a[href="${href}"]:visible`).first().click();
}

function isNavigationRscRequest(route: Route, pathname: string): boolean {
  const request = route.request();
  const url = new URL(request.url());
  return (
    url.pathname === pathname &&
    url.searchParams.has("_rsc") &&
    request.headers()["rsc"] === "1" &&
    request.headers()["x-vinext-rsc-render-mode"] === undefined
  );
}

async function blockNextNavigationRscRequest(page: Page, pathname: string) {
  let releaseRequest: (() => void) | null = null;
  let markBlocked: (() => void) | null = null;
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });

  const handler = async (route: Route) => {
    if (!isNavigationRscRequest(route, pathname)) {
      await route.continue();
      return;
    }

    markBlocked?.();
    await release;
    await route.continue().catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Route is already handled")) return;
      throw error;
    });
  };

  await page.route("**/*", handler);
  return {
    blocked,
    async release() {
      releaseRequest?.();
      await page.unroute("**/*", handler);
    },
  };
}

async function releaseBlockedNavigation(
  page: Page,
  blockedNavigation: Awaited<ReturnType<typeof blockNextNavigationRscRequest>>,
) {
  await blockedNavigation.release();
  await page.clock.fastForward(1_000).catch(() => {});
}

async function expectNoRscRequests(page: Page, action: () => Promise<void>) {
  const requests: string[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers()["rsc"] === "1" || url.searchParams.has("_rsc")) {
      requests.push(route.request().url());
    }
    await route.continue();
  };

  await page.route("**/*", handler);
  try {
    await action();
    await page.waitForTimeout(100);
  } finally {
    await page.unroute("**/*", handler);
  }
  expect(requests).toEqual([]);
}

async function expectNextNavigationRscRequest(page: Page, action: () => Promise<void>) {
  let resolveRequest: (() => void) | null = null;
  const sawRequest = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers()["rsc"] === "1" && url.searchParams.has("_rsc")) {
      resolveRequest?.();
    }
    await route.continue();
  };

  await page.route("**/*", handler);
  try {
    await action();
    await sawRequest;
  } finally {
    await page.unroute("**/*", handler);
  }
}

test.describe("Next.js compat: cached navigations", () => {
  // Ported from Next.js: test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
  test("serves cached static segments instantly on the second navigation", async ({ page }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/partially-static`;

    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
    await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
    await expect(visibleId(page, "headers-boundary")).toContainText("Header:");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const secondRequest = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await secondRequest.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "search-params-boundary", "Loading search params...");
      await expectVisibleIdText(page, "cookies-boundary", "Loading cookies...");
      await expectVisibleIdText(page, "headers-boundary", "Loading headers...");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, secondRequest);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
    await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
    await expect(visibleId(page, "headers-boundary")).toContainText("Header:");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(120_000);

    const thirdRequest = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await thirdRequest.blocked;
      await expectVisibleMainNotToContain(page, "Cached content");
    } finally {
      await releaseBlockedNavigation(page, thirdRequest);
    }

    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("serves a fully static page without any requests on the second navigation", async ({
    page,
  }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/fully-static`;

    await clickLink(page, target);
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");

    await expectNoRscRequests(page, async () => {
      await clickLink(page, target);
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    });
  });

  test("caches static segments when navigating to a known route without a prefetch", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/partially-static`;

    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(130_000);

    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const blocked = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("replays a cached static shell for gesture navigations", async ({ page }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/partially-static`;

    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const blocked = await blockNextNavigationRscRequest(page, target);
    try {
      await page.getByTestId("gesture-shell-navigation").click();
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("includes static params in the cached static stage", async ({ page }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/with-static-params/foo`;
    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "params")).toContainText("Param: foo");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const blocked = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expect(visibleId(page, "params")).toContainText("Param: foo");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("defers fallback params to the runtime stage", async ({ page }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/with-fallback-params/foo`;
    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "params-boundary")).toContainText("Param: foo");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const blocked = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "params-boundary", "Loading params...");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "params-boundary")).toContainText("Param: foo");
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("defers params missing from nested generateStaticParams to the runtime stage", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/with-partial-static-params/en/foo`;
    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "params-boundary")).toContainText("Locale: en, Param: foo");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const blocked = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "params-boundary", "Loading params...");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "params-boundary")).toContainText("Locale: en, Param: foo");
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("caches runtime-prefetchable content from a navigation for instant second visit", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    const target = `${BASE}/runtime-prefetchable`;

    await clickLink(page, target);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
    await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
    await expect(visibleId(page, "headers-boundary")).toContainText("Header:");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");

    const secondRequest = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await secondRequest.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
      await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
      await expect(visibleId(page, "headers-boundary")).toContainText("Header:");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, secondRequest);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const thirdRequest = await blockNextNavigationRscRequest(page, target);
    try {
      await clickLink(page, target);
      await thirdRequest.blocked;
      await expectVisibleMainNotToContain(page, "Cached content");
      await expectVisibleMainNotToContain(page, "Search params:");
      await expectVisibleMainNotToContain(page, "Cookie:");
      await expectVisibleMainNotToContain(page, "Header:");
      await expectVisibleMainNotToContain(page, "Dynamic content");
    } finally {
      await releaseBlockedNavigation(page, thirdRequest);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("caches pages from the initial HTML for subsequent navigations", async ({ page }) => {
    await page.clock.install();
    await page.goto(`${BASE}/partially-static`);
    await waitForAppRouterHydration(page);
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");

    await clickLink(page, BASE);
    await expect(page.locator("h1:visible").first()).toHaveText("Home");

    const blocked = await blockNextNavigationRscRequest(page, `${BASE}/partially-static`);
    try {
      await clickLink(page, `${BASE}/partially-static`);
      await blocked.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, blocked);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("caches runtime-prefetchable content from the initial HTML for subsequent navigations", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${BASE}/runtime-prefetchable`);
    await waitForAppRouterHydration(page);
    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
    await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
    await expect(visibleId(page, "headers-boundary")).toContainText("Header:");

    await clickLink(page, BASE);
    await expect(page.locator("h1:visible").first()).toHaveText("Home");

    const secondRequest = await blockNextNavigationRscRequest(page, `${BASE}/runtime-prefetchable`);
    try {
      await clickLink(page, `${BASE}/runtime-prefetchable`);
      await secondRequest.blocked;
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
      await expect(visibleId(page, "search-params-boundary")).toContainText("Search params:");
      await expect(visibleId(page, "cookies-boundary")).toContainText("Cookie:");
      await expect(visibleId(page, "headers-boundary")).toContainText("Header:");
      await expectVisibleIdText(page, "connection-boundary", "Loading connection...");
    } finally {
      await releaseBlockedNavigation(page, secondRequest);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");

    await page.goBack();
    await expect(page.locator("h1:visible").first()).toHaveText("Home");
    await page.clock.fastForward(60_000);

    const thirdRequest = await blockNextNavigationRscRequest(page, `${BASE}/runtime-prefetchable`);
    try {
      await clickLink(page, `${BASE}/runtime-prefetchable`);
      await thirdRequest.blocked;
      await expectVisibleMainNotToContain(page, "Cached content");
      await expectVisibleMainNotToContain(page, "Search params:");
      await expectVisibleMainNotToContain(page, "Cookie:");
      await expectVisibleMainNotToContain(page, "Header:");
      await expectVisibleMainNotToContain(page, "Dynamic content");
    } finally {
      await releaseBlockedNavigation(page, thirdRequest);
    }

    await expect(visibleId(page, "connection-boundary")).toContainText("Dynamic content");
  });

  test("caches a fully static page from the initial HTML for subsequent navigations", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${BASE}/fully-static`);
    await waitForAppRouterHydration(page);
    await expect(visibleId(page, "cached-content")).toContainText("Cached content");

    await clickLink(page, BASE);
    await expect(page.locator("h1:visible").first()).toHaveText("Home");

    await expectNoRscRequests(page, async () => {
      await clickLink(page, `${BASE}/fully-static`);
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    });

    await expectNoRscRequests(page, async () => {
      await clickLink(page, BASE);
      await expect(page.locator("h1:visible").first()).toHaveText("Home");
    });

    await page.clock.fastForward(180_000);

    await expectNextNavigationRscRequest(page, async () => {
      await clickLink(page, `${BASE}/fully-static`);
      await expect(visibleId(page, "cached-content")).toContainText("Cached content");
    });
  });
});
