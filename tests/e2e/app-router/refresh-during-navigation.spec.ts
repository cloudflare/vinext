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

  test("refresh still works after canceling a document navigation", async ({ page }) => {
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    // A real gesture enables the browser's beforeunload confirmation.
    await page.getByTestId("refresh").click();
    let dismissed = false;
    page.once("dialog", async (dialog) => {
      await dialog.dismiss();
      dismissed = true;
    });
    await page.evaluate(() => {
      window.addEventListener(
        "beforeunload",
        (event) => {
          event.preventDefault();
          event.returnValue = "";
        },
        { once: true },
      );
      const router = window.next?.router;
      if (!router) throw new Error("App Router is not installed");
      void router.push("/old-school");
    });
    await expect.poll(() => dismissed).toBe(true);
    const requests = trackRscRequests(page, START_PATH);
    await page.getByTestId("refresh").click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(page).toHaveURL(START_URL);
    await expect(page.getByTestId("refresh-nav-start")).toBeVisible();
    // A canceled MPA attempt must not suppress a later retry of the same URL.
    await page.evaluate(() => {
      void window.next!.router!.push("/old-school");
    });
    await expect(page).toHaveURL(`${BASE}/old-school`);
  });

  test("a Pages navigation supersedes a navigation with a queued refresh", async ({ page }) => {
    await page.goto(START_URL);
    await waitForAppRouterHydration(page);
    const slowRequests = trackRscRequests(page, SLOW_PATH);
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documents.push(new URL(request.url()).pathname);
    });
    let releaseNavigation: (() => void) | undefined;
    let releaseDocument: (() => void) | undefined;
    await page.route(`**${SLOW_PATH}*`, async (route) => {
      if (route.request().headers().rsc === "1" && !releaseNavigation) {
        await new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        });
      }
      await route.continue();
    });
    await page.route("**/old-school", async (route) => {
      await new Promise<void>((resolve) => {
        releaseDocument = resolve;
      });
      await route.continue();
    });
    try {
      await page.getByTestId("push-then-refresh").click();
      await expect.poll(() => releaseNavigation !== undefined).toBe(true);
      await page.evaluate(() => {
        const router = window.next?.router;
        if (!router) throw new Error("App Router is not installed");
        void router.push("/old-school");
      });
      await expect.poll(() => releaseDocument !== undefined).toBe(true);
      releaseNavigation?.();
      // Give the old root enough time to resolve while the document is held.
      await page.waitForTimeout(2500);
      expect(slowRequests).toHaveLength(1);
      expect(documents).toEqual(["/old-school"]);
      releaseDocument?.();
      await expect(page).toHaveURL(`${BASE}/old-school`);
    } finally {
      releaseNavigation?.();
      releaseDocument?.();
    }
  });

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

  // Next.js: test/e2e/app-dir/actions-discarded-navigation-revert/actions-discarded-navigation-revert.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-discarded-navigation-revert/actions-discarded-navigation-revert.test.ts
  for (const redirects of [false, true]) {
    test(`refresh waits for a held Server Action (redirect: ${redirects})`, async ({ page }) => {
      const actionPath = redirects ? SLOW_PATH : "/nextjs-compat/action-refresh-no-rerender";
      await page.goto(`${BASE}${actionPath}`);
      await waitForAppRouterHydration(page);
      const oldValue = redirects ? null : await page.locator("#flag-value").textContent();
      let releaseAction: (() => void) | undefined;
      const refreshPaths: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "GET" && request.headers().rsc === "1") {
          refreshPaths.push(new URL(request.url()).pathname);
        }
      });
      await page.route(`**${actionPath}*`, async (route) => {
        if (route.request().method() === "POST") {
          await new Promise<void>((resolve) => {
            releaseAction = resolve;
          });
        }
        await route.continue();
      });
      try {
        await page
          .locator(redirects ? '[data-testid="action-redirect"]' : "#action-refresh-from-server")
          .click();
        await expect.poll(() => releaseAction !== undefined).toBe(true);
        await page.evaluate(() => {
          const router = window.next!.router!;
          if ("refresh" in router) router.refresh();
        });
        await page.waitForTimeout(200);
        expect(refreshPaths).toEqual([]);
        releaseAction?.();
        await expect(page).toHaveURL(`${BASE}${redirects ? START_PATH : actionPath}`);
        await expect.poll(() => refreshPaths).toEqual([redirects ? START_PATH : actionPath]);
        if (!redirects) await expect(page.locator("#flag-value")).not.toHaveText(oldValue!);
      } finally {
        releaseAction?.();
      }
    });
  }

  for (const redirects of [false, true]) {
    test(`a queued Server Action uses the accepted destination (redirect: ${redirects})`, async ({
      page,
    }) => {
      const originalPath = redirects ? START_PATH : "/nextjs-compat/action-refresh-no-rerender";
      await page.goto(`${BASE}${originalPath}`);
      await waitForAppRouterHydration(page);
      let releaseNavigation: (() => void) | undefined;
      const posts: { pathname: string; visible: string }[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") {
          posts.push({ pathname: new URL(request.url()).pathname, visible: page.url() });
        }
      });
      await page.route(`**${SLOW_PATH}*`, async (route) => {
        if (route.request().method() === "GET") {
          await new Promise<void>((resolve) => {
            releaseNavigation = resolve;
          });
        }
        await route.continue();
      });
      try {
        await page.evaluate((href) => {
          void window.next!.router!.push(href);
        }, SLOW_PATH);
        await expect.poll(() => releaseNavigation !== undefined).toBe(true);
        await page
          .locator(redirects ? '[data-testid="action-redirect"]' : "#action-refresh-from-server")
          .click();
        await page.waitForTimeout(200);
        expect(posts).toEqual([]);
        releaseNavigation?.();
        await expect.poll(() => posts.length).toBe(1);
        expect(posts[0].pathname).toBe(SLOW_PATH);
        await expect(page).toHaveURL(redirects ? START_URL : SLOW_URL);
        await expect(page.getByTestId(redirects ? "refresh-nav-start" : "slow-page")).toBeVisible();
        if (!redirects) {
          await page.goBack();
          await expect(page).toHaveURL(`${BASE}${originalPath}`);
        }
      } finally {
        releaseNavigation?.();
      }
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
  for (const [startPath, savedScroll] of [
    [START_PATH, 0],
    ["/commit-race/start", 500],
  ] as const) {
    test(`a queued refresh preserves uncached Back history and scroll ${savedScroll}`, async ({
      page,
    }) => {
      const startUrl = `${BASE}${startPath}`;
      await page.goto(startUrl);
      await waitForAppRouterHydration(page);
      const initialHistoryIndex = await page.evaluate(() => history.state.__vinext_historyIndex);
      await page.evaluate(
        ({ savedScroll, slowPath }) => {
          window.scrollTo(0, savedScroll);
          void window.next!.router!.push(slowPath);
        },
        { savedScroll, slowPath: SLOW_PATH },
      );
      await expect(page).toHaveURL(SLOW_URL);
      await expect(page.getByTestId("slow-page")).toBeVisible();

      let releaseRefresh: (() => void) | undefined;
      let releaseTraversal: (() => void) | undefined;
      let traversalReleased = false;
      let refreshedBeforeTraversal = false;
      const startRequests = trackRscRequests(page, startPath);
      await page.route(`**${SLOW_PATH}*`, async (route) => {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        await route.continue();
      });
      await page.route(`**${startPath}?*`, async (route) => {
        if (!isAppRouterRscRequestForPath(route.request(), startPath)) return route.continue();
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
        await expect(page).toHaveURL(startUrl);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedScroll);
        await page.evaluate((href) => {
          void window.next!.router!.replace(href);
        }, `${startUrl}?after-back=1`);
        await expect(page).toHaveURL(`${startUrl}?after-back=1`);
        expect(await page.evaluate(() => history.state.__vinext_historyIndex)).toBe(
          initialHistoryIndex,
        );
        releaseRefresh?.();
        await page.unroute(`**${SLOW_PATH}*`);
        await page.goForward();
        await expect(page).toHaveURL(SLOW_URL);
        await page.goBack();
        await expect(page).toHaveURL(`${startUrl}?after-back=1`);
        expect(await page.evaluate(() => history.state.__vinext_historyIndex)).toBe(
          initialHistoryIndex,
        );
      } finally {
        releaseTraversal?.();
        releaseRefresh?.();
      }
    });
  }

  for (const redirectType of ["push", "replace"] as const) {
    test(`a refresh redirect after Back uses the redirected ${redirectType} history entry`, async ({
      page,
    }) => {
      const startPath = "/commit-race/start";
      const targetPath = "/nextjs-compat/hash-popstate-scroll/plain";
      await page.goto(`${BASE}${startPath}`);
      await waitForAppRouterHydration(page);
      const initialIndex = await page.evaluate(() => history.state.__vinext_historyIndex);
      await page.evaluate((href) => {
        history.scrollRestoration = "manual";
        scrollTo(0, 500);
        void window.next!.router!.push(href);
      }, SLOW_PATH);
      await expect(page).toHaveURL(SLOW_URL);
      let releaseAction: (() => void) | undefined;
      let backRequests = 0;
      await page.route(`**${SLOW_PATH}*`, async (route) => {
        await new Promise<void>((resolve) => {
          releaseAction = resolve;
        });
        await route.continue();
      });
      await page.route(`**${startPath}?*`, async (route) => {
        backRequests += 1;
        if (backRequests !== 2) return route.continue();
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            "x-vinext-rsc-redirect": targetPath,
            "x-vinext-rsc-redirect-type": redirectType,
          },
        });
      });
      try {
        await page.getByTestId("refresh-twice").click();
        await expect.poll(() => releaseAction !== undefined).toBe(true);
        await page.goBack();
        await expect(page).toHaveURL(`${BASE}${targetPath}`);
        expect(backRequests).toBe(2);
        const index = await page.evaluate(() => history.state.__vinext_historyIndex);
        if (redirectType === "push") expect(index).toBeGreaterThan(initialIndex);
        else expect(index).toBe(initialIndex);
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        releaseAction?.();
        await page.unroute(`**${SLOW_PATH}*`);
        if (redirectType === "push") {
          await page.goBack();
          await expect(page).toHaveURL(`${BASE}${startPath}`);
        }
      } finally {
        releaseAction?.();
      }
    });
  }

  test("canceling a queued refresh document fallback retains the Back history index", async ({
    page,
  }) => {
    const startPath = "/commit-race/start";
    await page.goto(`${BASE}${startPath}`);
    await waitForAppRouterHydration(page);
    const initialIndex = await page.evaluate(() => history.state.__vinext_historyIndex);
    await page.evaluate((href) => {
      void window.next!.router!.push(href);
    }, SLOW_PATH);
    await expect(page).toHaveURL(SLOW_URL);
    let releaseRefresh: (() => void) | undefined;
    let requests = 0;
    let canceled = false;
    await page.route(`**${SLOW_PATH}*`, async (route) => {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      await route.continue();
    });
    await page.route(`**${startPath}?*`, async (route) => {
      requests += 1;
      if (requests !== 2) return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-type": "text/html" },
      });
    });
    page.once("dialog", async (dialog) => {
      await dialog.dismiss();
      canceled = true;
    });
    try {
      await page.getByTestId("refresh-twice").click();
      await expect.poll(() => releaseRefresh !== undefined).toBe(true);
      await page.evaluate(() => {
        addEventListener(
          "beforeunload",
          (event) => {
            event.preventDefault();
            event.returnValue = "";
          },
          { once: true },
        );
      });
      await page.goBack();
      await expect.poll(() => canceled).toBe(true);
      await page.evaluate((href) => {
        void window.next!.router!.replace(href);
      }, `${startPath}?after-cancel=1`);
      await expect(page).toHaveURL(`${BASE}${startPath}?after-cancel=1`);
      await expect(
        page.getByRole("heading", { name: "Commit race start", exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => history.state.__vinext_historyIndex)).toBe(initialIndex);
    } finally {
      releaseRefresh?.();
    }
  });

  test("a queued refresh preserves pending scroll from a prefetched Back commit", async ({
    page,
  }) => {
    const targetPath = "/commit-race/start";
    await page.goto(`${BASE}${targetPath}`);
    await waitForAppRouterHydration(page);
    await page.evaluate((href) => {
      history.scrollRestoration = "manual";
      window.scrollTo(0, 500);
      void window.next!.router!.push(href);
    }, START_PATH);
    await expect(page).toHaveURL(START_URL);
    const freshResponse = page.waitForResponse((response) =>
      isAppRouterRscRequestForPath(response.request(), START_PATH),
    );
    await page.evaluate(() => {
      const router = window.next!.router!;
      if ("refresh" in router) router.refresh();
    });
    expect(await (await freshResponse).finished()).toBeNull();
    const prefetchResponse = page.waitForResponse((response) =>
      isAppRouterRscRequestForPath(response.request(), targetPath),
    );
    await page.evaluate((href) => {
      void window.next!.router!.prefetch(href);
    }, targetPath);
    expect(await (await prefetchResponse).finished()).toBeNull();
    await page.waitForTimeout(250);
    let releaseRefresh: (() => void) | undefined;
    await page.route(`**${targetPath}?*`, async (route) => {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      await route.continue();
    });
    try {
      await page.evaluate(() => {
        window.addEventListener(
          "popstate",
          () => {
            const router = window.next!.router!;
            if ("refresh" in router) router.refresh();
          },
          { once: true },
        );
        history.back();
      });
      await expect.poll(() => releaseRefresh !== undefined).toBe(true);
      // The prefetched traversal already committed; its scroll work did not.
      await expect(
        page.getByRole("heading", { name: "Commit race start", exact: true }),
      ).toBeVisible();
      releaseRefresh?.();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
      await page.unroute(`**${targetPath}?*`);
      const idleRefresh = page.waitForResponse((response) =>
        isAppRouterRscRequestForPath(response.request(), targetPath),
      );
      await page.evaluate(() => {
        window.scrollTo(0, 200);
        const router = window.next!.router!;
        if ("refresh" in router) router.refresh();
      });
      expect(await (await idleRefresh).finished()).toBeNull();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(200);
    } finally {
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
