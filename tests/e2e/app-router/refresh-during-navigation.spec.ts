import { expect, test, type Page, type Request } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const START_PATH = "/refresh-during-navigation";
const SLOW_PATH = "/refresh-during-navigation/slow";
const START_URL = `${BASE}${START_PATH}`;
const SLOW_URL = `${BASE}${SLOW_PATH}`;

// Next.js queues ACTION_REFRESH behind a pending action and runs it after that
// action finishes. ACTION_NAVIGATE discards the pending action. A refresh does
// not.
// packages/next/src/client/components/app-router-instance.ts dispatchAction
// Installed copy: node_modules/next/dist/client/components/app-router-instance.js
// lines 143-162 and publicAppRouterInstance.refresh at 355-360.
//
// Chrome can report net::ERR_ABORTED for a Flight response after React has
// already applied it, while the navigation abort signal stays quiet. The
// contract below is the destination commit, then one refetch of that URL.

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

  test("a refresh during an open navigation refetches the committed URL", async ({ page }) => {
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

    await expect(page).toHaveURL(SLOW_URL);
    await expect(page.getByTestId("slow-page")).toHaveText(/\d+/);
    const firstHeading = await page.getByTestId("slow-page").textContent();
    expect(await urlAtSecondSlowRequest).toBe(SLOW_URL);
    await expect(page.getByTestId("slow-page")).not.toHaveText(firstHeading ?? "", {
      timeout: 15_000,
    });
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

    const urlAtSecondSlowRequest = urlWhenRequestCountReaches(page, slowRequests, 2);
    await page.getByTestId("push-then-refresh").click();
    await expect(page).toHaveURL(SLOW_URL);
    await expect(page.getByTestId("slow-page")).toHaveText(/\d+/);
    const firstHeading = await page.getByTestId("slow-page").textContent();

    expect(await urlAtSecondSlowRequest).toBe(SLOW_URL);
    await expect(page.getByTestId("slow-page")).not.toHaveText(firstHeading ?? "", {
      timeout: 15_000,
    });
    expect(startRequests).toEqual([]);
    expect(slowRequests).toHaveLength(2);
  });
});
