import { expect, test, type Page, type Request } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const START_PATH = "/refresh-during-navigation";
const SLOW_PATH = "/refresh-during-navigation/slow";
const START_URL = `${BASE}${START_PATH}`;
const SLOW_URL = `${BASE}${SLOW_PATH}`;

// Next.js queues ACTION_REFRESH behind a pending router action, which resolves
// when its router-state result is available, before streamed children finish.
// Each public refresh is a separate action. ACTION_NAVIGATE discards a pending
// action; refresh does not.
// packages/next/src/client/components/app-router-instance.ts dispatchAction
// Installed copy: node_modules/next/dist/client/components/app-router-instance.js
// lines 143-162 and publicAppRouterInstance.refresh at 355-360.
//
// Chrome can report net::ERR_ABORTED for a Flight response after React has
// already applied it, while the navigation abort signal stays quiet. The
// assertions use request ordering and the final destination, independently of EOF.

type TrackedRequest = {
  finished: boolean;
  request: Request;
};

function trackRscRequests(page: Page, pathname: string): TrackedRequest[] {
  const tracked: TrackedRequest[] = [];

  const remember = (request: Request, finished: boolean) => {
    if (!isAppRouterRscRequestForPath(request, pathname)) return;
    const existing = tracked.find((entry) => entry.request === request);
    if (existing) {
      existing.finished = existing.finished || finished;
      return;
    }
    tracked.push({ finished, request });
  };

  page.on("request", (request) => {
    remember(request, false);
  });
  page.on("requestfinished", (request) => {
    remember(request, true);
  });
  page.on("requestfailed", (request) => {
    remember(request, true);
  });

  return tracked;
}

function urlWhenRequestCountReaches(
  page: Page,
  tracked: TrackedRequest[],
  count: number,
): Promise<string> {
  if (tracked.length >= count) return Promise.resolve(page.url());

  return new Promise((resolve) => {
    const onRequest = () => {
      if (tracked.length < count) return;
      page.off("request", onRequest);
      resolve(page.url());
    };
    page.on("request", onRequest);
  });
}

test.describe("refresh during an App Router navigation", () => {
  test.describe.configure({ timeout: 60_000 });

  test("a queued refresh cannot replace a hard navigation with the previous document", async ({
    page,
  }) => {
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    const startRequests = trackRscRequests(page, START_PATH);
    let releaseDocument: (() => void) | undefined;
    await page.route(`**${START_PATH}**`, async (route) => {
      const request = route.request();
      if (request.headers().rsc === "1") {
        await route.fulfill({ contentType: "text/html", body: "<p>Document fallback</p>" });
        return;
      }
      if (request.isNavigationRequest() && new URL(request.url()).pathname === SLOW_PATH) {
        await new Promise<void>((resolve) => {
          releaseDocument = resolve;
        });
      }
      await route.continue();
    });
    try {
      await page.getByTestId("push-then-refresh").click({ noWaitAfter: true });
      await expect.poll(() => releaseDocument !== undefined).toBe(true);
      await page.waitForTimeout(200);
      expect(startRequests).toEqual([]);
      releaseDocument?.();
      await expect(page).toHaveURL(SLOW_URL);
      await expect(page.getByTestId("slow-page")).toBeVisible();
    } finally {
      releaseDocument?.();
    }
  });

  test("a child layout effect can refresh during initial hydration", async ({ page }) => {
    const requests = trackRscRequests(page, START_PATH);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${START_URL}?refresh-on-mount=1`);
    await waitForAppRouterHydration(page);
    await expect.poll(() => requests.length).toBe(1);
    await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const refreshCount of [1, 2]) {
    test(`${refreshCount} refresh calls fetch while the committed navigation still streams`, async ({
      page,
    }) => {
      const requests = trackRscRequests(page, `${START_PATH}/streaming`);
      await page.goto(START_URL);
      await waitForAppRouterHydration(page);
      await page.getByTestId("link-streaming").click();
      await expect(page.getByTestId("stream-pending")).toBeVisible();
      expect(requests[0].finished).toBe(false);
      await page.getByTestId(refreshCount === 1 ? "refresh" : "refresh-twice").click();
      await expect.poll(() => requests.length, { timeout: 3_000 }).toBe(1 + refreshCount);
      expect(requests[0].finished).toBe(false);
    });
  }

  test("refresh after an action redirect does not wait for the previous stream", async ({
    page,
  }) => {
    const streamingRequests = trackRscRequests(page, `${START_PATH}/streaming`);
    const startRequests = trackRscRequests(page, START_PATH);
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    await page.getByTestId("link-streaming").click();
    await expect(page.getByTestId("stream-pending")).toBeVisible();
    expect(streamingRequests[0].finished).toBe(false);
    await page.getByTestId("action-redirect").click();
    await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
    await expect(page).toHaveURL(START_URL);
    expect(streamingRequests[0].finished).toBe(false);
    await page.getByTestId("refresh").click();
    await expect.poll(() => startRequests.length, { timeout: 3_000 }).toBe(1);
  });

  test("a same-document Back supersedes a pending navigation before refresh", async ({ page }) => {
    let releaseNavigation: (() => void) | undefined;
    await page.route(`**${SLOW_PATH}*`, async (route) => {
      await new Promise<void>((resolve) => {
        releaseNavigation = resolve;
      });
      await route.continue();
    });
    const startRequests = trackRscRequests(page, START_PATH);
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => window.history.pushState(null, "", "#top"));

    try {
      await page.getByTestId("link-slow").click({ noWaitAfter: true });
      await expect.poll(() => releaseNavigation !== undefined).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(START_URL);
      await page.getByTestId("refresh").click();
      await expect.poll(() => startRequests.length, { timeout: 3_000 }).toBe(1);
      await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
    } finally {
      releaseNavigation?.();
    }
  });

  for (const method of ["router", "pushState", "replaceState"] as const) {
    test(`${method} hash navigation supersedes an older stream before refresh`, async ({
      page,
    }) => {
      const streamingRequests = trackRscRequests(page, `${START_PATH}/streaming`);
      await page.goto(START_URL);
      await waitForAppRouterHydration(page);
      await page.getByTestId("link-streaming").click();
      await expect(page.getByTestId("stream-pending")).toBeVisible();
      expect(streamingRequests).toHaveLength(1);
      expect(streamingRequests[0].finished).toBe(false);

      if (method === "router") {
        await page.getByTestId("hash-then-refresh").click();
      } else {
        await page.evaluate((method) => window.history[method](null, "", "#top"), method);
        await page.getByTestId("refresh").click();
      }
      await expect.poll(() => streamingRequests.length, { timeout: 3_000 }).toBe(2);
      await expect(page).toHaveURL(`${BASE}${START_PATH}/streaming#top`);
    });
  }

  // Next.js replaces the pending navigation when a newer navigation starts;
  // only the winning action gates queued refreshes.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
  for (const [restore, refreshBeforeLeaving] of [
    ["link", true],
    ["link", false],
    ["back", true],
    ["back", false],
  ] as const) {
    test(`an older stream does not block a refresh ${refreshBeforeLeaving ? "queued before" : "requested after"} leaving it via ${restore}`, async ({
      page,
    }) => {
      const streamingRequests = trackRscRequests(page, `${START_PATH}/streaming`);
      const startRequests = trackRscRequests(page, START_PATH);
      await page.goto(START_URL);
      await waitForAppRouterHydration(page);
      await page.getByTestId("link-streaming").click();
      await expect(page.getByTestId("stream-pending")).toBeVisible();
      expect(streamingRequests).toHaveLength(1);
      expect(streamingRequests[0].finished).toBe(false);

      if (refreshBeforeLeaving) await page.getByTestId("refresh").click();
      if (restore === "back") {
        await page.goBack();
      } else {
        await page.getByTestId("link-start").click();
      }
      await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
      // The initial visit is cached. The only subsequent start-route request
      // must be the refresh, which should not wait for the old streaming tail.
      if (!refreshBeforeLeaving) await page.getByTestId("refresh").click();
      await expect.poll(() => startRequests.length, { timeout: 3_000 }).toBe(1);
      expect(streamingRequests[0].finished).toBe(false);
      await expect(page).toHaveURL(START_URL);
    });
  }

  // ACTION_RESTORE retains queued actions behind the winning restore.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
  test("a queued refresh waits for an uncached Back traversal", async ({ page }) => {
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    await page.getByTestId("link-slow").click();
    await expect(page).toHaveURL(SLOW_URL);
    await expect(page.getByTestId("slow-page")).toBeVisible();

    let releaseRefresh: (() => void) | undefined;
    let releaseTraversal: (() => void) | undefined;
    let traversalReleased = false;
    let refreshedBeforeTraversal = false;
    const startRequests = trackRscRequests(page, START_PATH);
    await page.route(`**${SLOW_PATH}*`, async (route) => {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      await route.continue();
    });
    await page.route(`**${START_PATH}?*`, async (route) => {
      if (!isAppRouterRscRequestForPath(route.request(), START_PATH)) return route.continue();
      if (!releaseTraversal) {
        await new Promise<void>((resolve) => {
          releaseTraversal = resolve;
        });
      } else if (!traversalReleased) {
        refreshedBeforeTraversal = true;
      }
      await route.continue();
    });
    try {
      await page.getByTestId("refresh-twice").click();
      await expect.poll(() => releaseRefresh !== undefined).toBe(true);
      await page.goBack();
      await expect.poll(() => releaseTraversal !== undefined).toBe(true);
      // The restore has not produced any router state yet.
      await page.waitForTimeout(200);
      expect(startRequests).toHaveLength(1);
      expect(refreshedBeforeTraversal).toBe(false);
      traversalReleased = true;
      releaseTraversal?.();
      await expect.poll(() => startRequests.length).toBe(2);
      await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
      await expect(page).toHaveURL(START_URL);
    } finally {
      releaseTraversal?.();
      releaseRefresh?.();
    }
  });

  test("a refresh targets the pending destination before navigation commits", async ({ page }) => {
    const slowRequests = trackRscRequests(page, SLOW_PATH);
    const startRequests = trackRscRequests(page, START_PATH);

    await page.goto(START_URL);
    await expect(page.getByTestId("refresh-nav-start")).toHaveText("Refresh navigation start");
    await waitForAppRouterHydration(page);
    expect(slowRequests).toEqual([]);

    const urlAtSecondSlowRequest = urlWhenRequestCountReaches(page, slowRequests, 2);
    await page.getByTestId("link-slow").click({ noWaitAfter: true });
    await expect.poll(() => slowRequests.some((entry) => !entry.finished)).toBe(true);
    await expect(page).toHaveURL(START_URL);

    const navigation = slowRequests.find((entry) => !entry.finished);
    if (!navigation) {
      throw new Error("Expected the slow navigation response to still be open");
    }

    // A DOM click does not wait for Playwright to consider the navigation
    // finished. Header arrival is too early: the body has to still be open.
    await page.locator('[data-testid="refresh"]').evaluate((button: HTMLButtonElement) => {
      button.click();
    });

    expect(navigation.finished).toBe(false);
    expect(page.url()).toBe(START_URL);
    expect(slowRequests).toHaveLength(1);
    expect(startRequests).toEqual([]);

    expect(await urlAtSecondSlowRequest).toBe(START_URL);
    expect(navigation.finished).toBe(false);
    await expect(page).toHaveURL(SLOW_URL);
    await expect(page.getByTestId("slow-page")).toHaveText(/\d+/);
    expect(startRequests).toEqual([]);
    expect(slowRequests).toHaveLength(2);
  });

  test("a same-task push and refresh both fetch the destination", async ({ page }) => {
    const slowRequests = trackRscRequests(page, SLOW_PATH);
    const startRequests = trackRscRequests(page, START_PATH);

    await page.goto(START_URL);
    await expect(page.getByTestId("refresh-nav-start")).toHaveText("Refresh navigation start");
    await waitForAppRouterHydration(page);
    expect(slowRequests).toEqual([]);

    const historyLength = await page.evaluate(() => history.length);
    const urlAtSecondSlowRequest = urlWhenRequestCountReaches(page, slowRequests, 2);
    await page.getByTestId("push-then-refresh").click();
    expect(await urlAtSecondSlowRequest).toBe(START_URL);
    expect(slowRequests[0].finished).toBe(false);
    await expect(page).toHaveURL(SLOW_URL);
    await expect(page.getByTestId("slow-page")).toHaveText(/\d+/);
    // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    expect(startRequests).toEqual([]);
    expect(slowRequests).toHaveLength(2);
    await page.goBack();
    await expect(page).toHaveURL(START_URL);
  });
});
