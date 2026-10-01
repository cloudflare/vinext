import { expect, test, type Page, type Request as PlaywrightRequest } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const START = "/refresh-during-navigation";
const DESTINATION = "/refresh-during-navigation/destination";
const STREAMING = "/refresh-during-navigation/streaming";
const SLOW_COMMIT = "/refresh-during-navigation/slow-commit";
const REDIRECT_TARGET = "/refresh-during-navigation/redirect-target";

// Next.js queues router.refresh() behind a pending navigation instead of
// discarding the navigation: only navigations take priority over pending
// actions. The refresh then runs on the navigation's result, so it refetches
// the destination rather than the page being left.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/refresh-reducer.ts
// https://github.com/cloudflare/vinext/issues/3543

/** Holds each RSC request for `pathname` until its index is released. */
async function holdRscRequests(page: Page, pathname: string): Promise<(index: number) => void> {
  const gates = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  const gate = (index: number) => {
    let entry = gates.get(index);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((resolveGate) => {
        resolve = resolveGate;
      });
      entry = { promise, resolve };
      gates.set(index, entry);
    }
    return entry;
  };
  let requestCount = 0;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      if (isAppRouterRscRequestForPath(route.request(), pathname)) {
        await gate(requestCount++).promise;
      }
      // The page may have aborted a request while it was held.
      await route.continue().catch(() => {});
    },
  );
  return (index) => gate(index).resolve();
}

/**
 * Records every client abort of an RSC fetch. Playwright's requestfailed is no
 * use here: in dev it reports ERR_ABORTED for streamed responses as they end.
 */
async function recordRscAborts(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const aborted: string[] = [];
    Reflect.set(window, "__rscAborts", aborted);
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : null;
      const href = input instanceof URL ? input.href : typeof input === "string" ? input : "";
      const url = new URL(request?.url ?? href, window.location.href);
      const signal = init?.signal ?? request?.signal;
      if (url.searchParams.has("_rsc") && signal) {
        signal.addEventListener("abort", () => aborted.push(url.pathname), { once: true });
      }
      return originalFetch(input, init);
    };
  });
  return () => page.evaluate(() => Reflect.get(window, "__rscAborts") as string[]);
}

/**
 * Opens the start page and watches for page errors and document reloads, so a
 * test can assert everything after it stayed a client navigation.
 */
async function openStartPage(page: Page) {
  const readAborts = await recordRscAborts(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}${START}`);
  await expect(page.locator("#start-page")).toBeVisible();
  await waitForAppRouterHydration(page);
  await page.evaluate(() => Reflect.set(window, "__refreshDuringNavigationDocument", true));
  return {
    readAborts,
    expectClientNavigationsOnly: async () => {
      const sameDocument = await page.evaluate(() =>
        Reflect.get(window, "__refreshDuringNavigationDocument"),
      );
      expect(sameDocument).toBe(true);
      expect(errors).toEqual([]);
    },
  };
}

/** Resolves once an RSC request for `pathname` finishes or fails. */
function waitForRscRequestEnd(page: Page, pathname: string): Promise<void> {
  return new Promise((resolve) => {
    const onEnd = (request: PlaywrightRequest) => {
      if (!isAppRouterRscRequestForPath(request, pathname)) return;
      page.off("requestfinished", onEnd);
      page.off("requestfailed", onEnd);
      resolve();
    };
    page.on("requestfinished", onEnd);
    page.on("requestfailed", onEnd);
  });
}

/** Records the fixture routes' RSC requests as they start. */
function recordRscRequests(page: Page): string[] {
  const started: string[] = [];
  page.on("request", (request: PlaywrightRequest) => {
    const path = [START, DESTINATION, STREAMING, SLOW_COMMIT, REDIRECT_TARGET].find((candidate) =>
      isAppRouterRscRequestForPath(request, candidate),
    );
    if (path) started.push(path);
  });
  return started;
}

test.describe("router.refresh() during an in-flight navigation", () => {
  test("runs after the navigation commits and refreshes its destination", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const release = await holdRscRequests(page, DESTINATION);
    const started = recordRscRequests(page);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    // The refresh did not cancel the navigation in flight.
    expect(await readAborts()).toEqual([]);
    release(0);

    // The navigation commits on its own response, with its history entry.
    await expect(page).toHaveURL(`${BASE}${DESTINATION}`);
    await expect(page.locator("#destination-page")).toBeVisible();
    await expect.poll(() => started).toEqual([DESTINATION, DESTINATION]);
    const navigationRenderedAt = await page.locator("#destination-rendered-at").textContent();

    // The queued refresh then refetches the destination and commits it.
    release(1);
    await expect(page.locator("#destination-rendered-at")).not.toHaveText(
      navigationRenderedAt ?? "",
    );
    await expect(page).toHaveURL(`${BASE}${DESTINATION}`);
    expect(await readAborts()).toEqual([]);

    await page.goBack();
    await expect(page.locator("#start-page")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${START}`);
    await expectClientNavigationsOnly();
  });

  test("runs after a back navigation that refetches, instead of cancelling it", async ({
    page,
  }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    await page.evaluate(() => window.scrollTo(0, 1500));
    // A DOM click, so Playwright does not scroll the link into view first.
    await page.evaluate(() => document.querySelector<HTMLElement>("#destination-link")?.click());
    await expect(page.locator("#destination-page")).toBeVisible();
    // A refresh drops the cached start page, so going back has to refetch it.
    const renderedAt = await page.locator("#destination-rendered-at").textContent();
    await page.locator("#refresh-button").click();
    await expect(page.locator("#destination-rendered-at")).not.toHaveText(renderedAt ?? "");

    const release = await holdRscRequests(page, START);
    const started = recordRscRequests(page);

    // Refresh from a popstate listener, which runs after the router has started
    // the traversal. Holding the traversal would outlast the scroll-restore
    // retries, so it goes through at once.
    release(0);
    await page.evaluate(() => {
      window.addEventListener(
        "popstate",
        () => document.querySelector<HTMLElement>("#refresh-button")?.click(),
        { once: true },
      );
      window.history.back();
    });

    await expect(page.locator("#start-page")).toBeVisible();
    // The queued refresh does not cancel the back navigation's scroll restore.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
    await expect.poll(() => started).toEqual([START, START]);
    const navigationRenderedAt = await page.locator("#start-rendered-at").textContent();
    release(1);
    await expect(page.locator("#start-rendered-at")).not.toHaveText(navigationRenderedAt ?? "");
    expect(await page.evaluate(() => window.scrollY)).toBe(1500);
    await expect(page).toHaveURL(`${BASE}${START}`);
    expect(started).toEqual([START, START]);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  test("runs after a back navigation that restores a snapshot over the navigation", async ({
    page,
  }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const startRenderedAt = await page.locator("#start-rendered-at").textContent();
    await page.locator("#destination-link").click();
    await expect(page.locator("#destination-page")).toBeVisible();
    const started = recordRscRequests(page);
    const slowCommitEnded = waitForRscRequestEnd(page, SLOW_COMMIT);

    // Accepted but not committed, so the restore cannot abort it.
    const accepted = page.waitForResponse((response) =>
      isAppRouterRscRequestForPath(response.request(), SLOW_COMMIT),
    );
    await page.locator("#slow-commit-link").click();
    await accepted;
    await page.locator("#refresh-button").click();
    // The replaced navigation has not committed when the restore takes over.
    expect(await page.locator("#slow-commit-page").count()).toBe(0);
    expect(page.url()).toBe(`${BASE}${DESTINATION}`);
    await page.evaluate(() => {
      // Runs after the router's listener, so the start page is already in the
      // DOM only if the router restored it synchronously from its snapshot.
      window.addEventListener(
        "popstate",
        () =>
          Reflect.set(window, "__restoredFromSnapshot", !!document.querySelector("#start-page")),
        { once: true },
      );
      window.history.back();
    });

    // The queued refresh has not invalidated the history snapshot yet, as in
    // Next.js, so Back restores the start page without a request, and the
    // refresh then runs on the restored page.
    await expect(page.locator("#start-page")).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "__restoredFromSnapshot"))).toBe(true);
    // The navigation's response was accepted before the restore, so the
    // restore did not abort it.
    expect(await readAborts()).toEqual([]);
    await expect.poll(() => started).toEqual([SLOW_COMMIT, START]);
    await expect(page.locator("#start-rendered-at")).not.toHaveText(startRenderedAt ?? "");
    // A refetching traversal would have added a second request.
    await page.waitForTimeout(500);
    expect(started).toEqual([SLOW_COMMIT, START]);
    await expect(page).toHaveURL(`${BASE}${START}`);

    // The replaced navigation's response finishes streaming without committing.
    await slowCommitEnded;
    await page.waitForTimeout(500);
    expect(await page.locator("#slow-commit-page").count()).toBe(0);
    await expect(page.locator("#start-page")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${START}`);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  test("moves a queued refresh behind a newer navigation", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const releaseDestination = await holdRscRequests(page, DESTINATION);
    const releaseStreaming = await holdRscRequests(page, STREAMING);
    const started = recordRscRequests(page);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    await page.locator("#streaming-link").click();
    await expect.poll(() => started).toEqual([DESTINATION, STREAMING]);
    releaseStreaming(0);

    // The refresh runs on the newer navigation's destination, not the one it
    // arrived behind.
    await expect(page.locator("#streaming-page")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${STREAMING}`);
    await expect.poll(() => started).toEqual([DESTINATION, STREAMING, STREAMING]);
    const navigationRenderedAt = await page.locator("#streaming-rendered-at").textContent();
    releaseStreaming(1);
    await expect(page.locator("#streaming-rendered-at")).not.toHaveText(navigationRenderedAt ?? "");
    releaseDestination(0);
    // Only the superseded navigation was cancelled.
    expect(await readAborts()).toEqual([DESTINATION]);
    await expectClientNavigationsOnly();
  });

  // A Server Action redirect renders over the navigation in flight without
  // waiting for it. The refresh still waits for that navigation, as everything
  // waits behind it in Next.js, then refreshes the redirect target. Next.js
  // instead runs the action after the navigation and the refresh (see
  // app-browser-refresh-queue.ts).
  test("runs a queued refresh on a Server Action redirect once the navigation ends", async ({
    page,
  }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const release = await holdRscRequests(page, DESTINATION);
    // The redirect's payload comes with the action's response; only the
    // refresh requests the target.
    const releaseRefresh = await holdRscRequests(page, REDIRECT_TARGET);
    const started = recordRscRequests(page);
    const destinationEnded = waitForRscRequestEnd(page, DESTINATION);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    // The refresh is queued, so it does not cancel the navigation.
    expect(await readAborts()).toEqual([]);
    await page.locator("#redirect-action-button").click();
    await expect(page.locator("#redirect-target-page")).toBeVisible();
    await page.waitForTimeout(500);
    expect(started).toEqual([DESTINATION]);

    // The navigation's response does not commit over the redirect, and the
    // refresh then runs on the redirect target.
    release(0);
    await destinationEnded;
    await expect.poll(() => started).toEqual([DESTINATION, REDIRECT_TARGET]);
    const redirectRenderedAt = await page.locator("#redirect-target-rendered-at").textContent();
    releaseRefresh(0);
    await expect(page.locator("#redirect-target-rendered-at")).not.toHaveText(
      redirectRenderedAt ?? "",
    );
    await expect(page).toHaveURL(`${BASE}${REDIRECT_TARGET}`);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  test("runs a queued refresh on a Server Action re-render once the navigation ends", async ({
    page,
  }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const renderedAt = await page.locator("#start-rendered-at").textContent();
    const release = await holdRscRequests(page, DESTINATION);
    const releaseRefresh = await holdRscRequests(page, START);
    const started = recordRscRequests(page);
    const destinationEnded = waitForRscRequestEnd(page, DESTINATION);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    // The refresh is queued, so it does not cancel the navigation.
    expect(await readAborts()).toEqual([]);
    await page.locator("#revalidate-action-button").click();
    await expect(page.locator("#start-rendered-at")).not.toHaveText(renderedAt ?? "");
    const actionRenderedAt = await page.locator("#start-rendered-at").textContent();
    await page.waitForTimeout(500);
    expect(started).toEqual([DESTINATION]);

    // The re-render committed over the navigation, so the navigation's
    // response is discarded as stale and the destination never shows (this
    // was already the case before the refresh queue). Next.js queues the
    // action behind the navigation and ends on the destination. The refresh
    // then runs on the start page.
    release(0);
    await destinationEnded;
    await expect.poll(() => started).toEqual([DESTINATION, START]);
    releaseRefresh(0);
    await expect(page.locator("#start-rendered-at")).not.toHaveText(actionRenderedAt ?? "");
    await expect(page.locator("#start-page")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${START}`);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  // The router drops the refresh as it starts the document load, where Next.js
  // still runs it, against the hard navigation's target URL.
  test("drops a refresh queued behind a navigation that loads a new document", async ({ page }) => {
    await openStartPage(page);
    let respond!: () => void;
    const responded = new Promise<void>((resolve) => {
      respond = resolve;
    });
    // Hold the document so the page being left stays alive while the
    // navigation's finally runs.
    let documentRequested!: () => void;
    const documentRequest = new Promise<void>((resolve) => {
      documentRequested = resolve;
    });
    let releaseDocument!: () => void;
    const documentReleased = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    // A response that is not a Flight payload makes the client load the
    // destination as a new document instead.
    await page.route(
      (url) => url.pathname === DESTINATION,
      async (route) => {
        if (!isAppRouterRscRequestForPath(route.request(), DESTINATION)) {
          documentRequested();
          await documentReleased;
          await route.continue().catch(() => {});
          return;
        }
        await responded;
        await route
          .fulfill({ body: "not a Flight payload", contentType: "text/plain" })
          .catch(() => {});
      },
    );
    const started = recordRscRequests(page);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    respond();
    await documentRequest;
    // A refresh released by the navigation's finally would start straight after.
    await page.waitForTimeout(500);
    releaseDocument();

    await expect(page.locator("#destination-page")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${DESTINATION}`);
    const sameDocument = await page.evaluate(() =>
      Reflect.get(window, "__refreshDuringNavigationDocument"),
    );
    expect(sameDocument).toBeUndefined();
    // No refresh of the page being unloaded.
    expect(started).toEqual([DESTINATION]);
  });

  // navigateExternal drops the refresh, which would otherwise replace its
  // deferred document load.
  test("drops a refresh queued behind a navigation that an external navigation replaces", async ({
    page,
  }) => {
    await openStartPage(page);
    // Hold the external document so the page being left stays alive while the
    // replaced navigation settles.
    let respond!: () => void;
    const responded = new Promise<void>((resolve) => {
      respond = resolve;
    });
    await page.route("https://external.example/**", async (route) => {
      await responded;
      await route
        .fulfill({ body: "<p id='external-page'>External</p>", contentType: "text/html" })
        .catch(() => {});
    });
    const release = await holdRscRequests(page, DESTINATION);
    const started = recordRscRequests(page);
    const destinationEnded = waitForRscRequestEnd(page, DESTINATION);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    // A DOM click, since Playwright's click would wait for the held document.
    await page.evaluate(() =>
      document.querySelector<HTMLElement>("#external-push-button")?.click(),
    );
    release(0);
    // The replaced navigation settles once its request ends (it may compile on
    // demand in dev); a refresh queued behind it would start straight after.
    await destinationEnded;
    await page.waitForTimeout(500);
    respond();

    await expect(page.locator("#external-page")).toBeVisible();
    expect(started).toEqual([DESTINATION]);
  });

  // The router does not start this document load, so the refresh is not
  // dropped, as in Next.js; it runs in the page being left without replacing
  // the load. Unlike Next.js, where the link discards the navigation in
  // flight, that navigation still settles first and the refresh refetches its
  // destination.
  test("runs a refresh queued behind a navigation that a Pages Router link replaces", async ({
    page,
  }) => {
    await openStartPage(page);
    // Hold the Pages document so the page being left stays alive while the
    // replaced navigation settles.
    let respond!: () => void;
    const responded = new Promise<void>((resolve) => {
      respond = resolve;
    });
    await page.route(
      (url) => url.pathname === "/old-school",
      async (route) => {
        await responded;
        await route.continue().catch(() => {});
      },
    );
    const release = await holdRscRequests(page, DESTINATION);
    const started = recordRscRequests(page);
    const destinationEnded = waitForRscRequestEnd(page, DESTINATION);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    // A DOM click, since Playwright's click would wait for the held document.
    await page.evaluate(() => document.querySelector<HTMLElement>("#pages-link")?.click());
    release(0);
    // The replaced navigation settles in the page being left once its request
    // ends, and the refresh then refetches the destination. (The page can't be
    // queried while its document load is pending.)
    await destinationEnded;
    await expect.poll(() => started).toEqual([DESTINATION, DESTINATION]);
    const refreshEnded = waitForRscRequestEnd(page, DESTINATION);
    release(1);
    await refreshEnded;
    // The refresh did not replace the pending load.
    respond();

    await expect(page.locator("h1")).toHaveText("Old School Pages Directory");
  });

  // Next.js queues a refresh behind a pending refresh (and never aborts its
  // fetch); vinext deliberately keeps superseding it, as it did before (see
  // app-browser-refresh-queue.ts).
  test("a refresh supersedes an in-flight refresh", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    await page.locator("#destination-link").click();
    await expect(page.locator("#destination-page")).toBeVisible();
    const renderedAt = await page.locator("#destination-rendered-at").textContent();

    const release = await holdRscRequests(page, DESTINATION);
    const started = recordRscRequests(page);
    await page.locator("#refresh-button").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    await expect.poll(() => started).toEqual([DESTINATION, DESTINATION]);
    expect(await readAborts()).toEqual([DESTINATION]);

    release(1);
    await expect(page.locator("#destination-rendered-at")).not.toHaveText(renderedAt ?? "");
    release(0);
    await expectClientNavigationsOnly();
  });

  // Next.js runs each queued refresh in turn; vinext deliberately runs the
  // refreshes queued behind one navigation once (see app-browser-refresh-queue.ts).
  test("runs refreshes queued behind the same navigation once", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const release = await holdRscRequests(page, DESTINATION);
    const started = recordRscRequests(page);

    await page.locator("#destination-link").click();
    await expect.poll(() => started).toEqual([DESTINATION]);
    await page.locator("#refresh-button").click();
    await page.locator("#refresh-button").click();
    expect(await readAborts()).toEqual([]);
    release(0);

    await expect(page.locator("#destination-page")).toBeVisible();
    await expect.poll(() => started).toEqual([DESTINATION, DESTINATION]);
    const navigationRenderedAt = await page.locator("#destination-rendered-at").textContent();
    release(1);
    await expect(page.locator("#destination-rendered-at")).not.toHaveText(
      navigationRenderedAt ?? "",
    );

    // A second queued refresh would have started as soon as the first committed.
    await page.waitForTimeout(500);
    expect(started).toEqual([DESTINATION, DESTINATION]);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  // Guards #3543's original failure: a second navigation aborted the first one's
  // still-streaming response, and the aborted payload then broke the next render.
  // The accepted-but-uncommitted case below covers the release that fixed it;
  // this checks the committed case end to end.
  test("a later navigation does not abort a committed navigation's stream", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const started = recordRscRequests(page);

    await page.locator("#streaming-link").click();
    await expect(page.locator("#streaming-fallback")).toBeVisible();
    await page.locator("#streaming-link").click();
    await expect.poll(() => started).toEqual([STREAMING, STREAMING]);

    await expect(page.locator("#streaming-section")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#streaming-page")).toBeVisible();
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  // The window #3543 reported: the first navigation's response is accepted but
  // React has not committed it yet when the second navigation starts.
  test("a later navigation does not abort an accepted, uncommitted navigation", async ({
    page,
  }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const started = recordRscRequests(page);

    const accepted = page.waitForResponse((response) =>
      isAppRouterRscRequestForPath(response.request(), SLOW_COMMIT),
    );
    await page.locator("#slow-commit-link").click();
    await accepted;
    expect(await page.locator("#slow-commit-page").count()).toBe(0);
    expect(page.url()).toBe(`${BASE}${START}`);
    await page.locator("#slow-commit-link").click();
    await expect.poll(() => started).toEqual([SLOW_COMMIT, SLOW_COMMIT]);
    // Still uncommitted when the second navigation started, or this would only
    // cover the committed case.
    expect(await page.locator("#slow-commit-page").count()).toBe(0);

    await expect(page.locator("#slow-commit-content")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(`${BASE}${SLOW_COMMIT}`);
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });

  test("does not wait for a committed navigation to finish streaming", async ({ page }) => {
    const { expectClientNavigationsOnly, readAborts } = await openStartPage(page);
    const started = recordRscRequests(page);

    await page.locator("#streaming-link").click();
    await expect(page.locator("#streaming-page")).toBeVisible();
    await expect(page.locator("#streaming-fallback")).toBeVisible();
    const navigationRenderedAt = await page.locator("#streaming-rendered-at").textContent();
    await page.locator("#refresh-button").click();

    // The refresh starts while the navigation's 8s Suspense boundary still
    // streams, instead of being held until the stream ends.
    await expect.poll(() => started, { timeout: 2_500 }).toEqual([STREAMING, STREAMING]);
    await expect(page.locator("#streaming-rendered-at")).not.toHaveText(navigationRenderedAt ?? "");
    await expect(page.locator("#streaming-section")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(`${BASE}${STREAMING}`);
    // The refresh did not cut the committed navigation's stream short.
    expect(await readAborts()).toEqual([]);
    await expectClientNavigationsOnly();
  });
});
