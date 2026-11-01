import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const TARGET_PREFIX = "/prefetch-queue-viewport/";
const TARGETS = ["1", "2", "3", "4", "5", "6", "7", "8"];

/** Resolves once every matching link is out of (or back in) the prefetch range. */
function waitForLinksIntersecting(
  page: Page,
  selector: string,
  intersecting: boolean,
): Promise<void> {
  return page.evaluate(
    ({ selector, expected }) =>
      new Promise<void>((resolve) => {
        const links = [...document.querySelectorAll(selector)];
        const state = new Map<Element, boolean>();
        // Same rootMargin as Link's observer. Observers are notified in creation
        // order, so Link's has already seen the change when this one resolves.
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) state.set(entry.target, entry.isIntersecting);
            if (links.every((link) => state.get(link) === expected)) {
              observer.disconnect();
              resolve();
            }
          },
          { rootMargin: "250px" },
        );
        for (const link of links) observer.observe(link);
      }),
    { selector, expected: intersecting },
  );
}

/**
 * Holds the first four target prefetches so the rest queue behind them, and
 * records every target prefetch request.
 */
async function holdPrefetchSlots(page: Page) {
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const state = {
    heldTargets: new Set<string>(),
    requestedTargets: [] as string[],
    /** The `Next-Url` header of each request in `requestedTargets`. */
    requestNextUrls: [] as Array<string | undefined>,
    releaseHeld,
  };

  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.headers()["next-router-prefetch"] !== "1" || !pathname.startsWith(TARGET_PREFIX)) {
      return route.continue();
    }
    const target = pathname.slice(TARGET_PREFIX.length).replace(/\.rsc$/, "");
    state.requestedTargets.push(target);
    state.requestNextUrls.push(request.headers()["next-url"]);
    if (state.heldTargets.size < 4) {
      state.heldTargets.add(target);
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  return state;
}

/** Waits until the queue holds all eight prefetches and keeps a barrier for them. */
async function waitForQueuedPrefetches(page: Page, heldTargets: Set<string>) {
  await expect.poll(() => heldTargets.size).toBe(4);
  const pendingPrefetches = () =>
    page.evaluate(() => {
      const state = window as unknown as {
        __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, { pending?: Promise<unknown> }>;
        __queuedPrefetches?: Promise<unknown>;
      };
      const pending = new Set(
        [...(state.__VINEXT_RSC_PREFETCH_CACHE__?.values() ?? [])].flatMap((entry) =>
          entry.pending ? [entry.pending] : [],
        ),
      );
      state.__queuedPrefetches = Promise.allSettled(pending);
      return pending.size;
    });
  await expect.poll(pendingPrefetches).toBeGreaterThanOrEqual(8);
}

function waitForQueuedPrefetchesToSettle(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __queuedPrefetches: Promise<unknown> }).__queuedPrefetches,
  );
}

// Next.js cancels a Link's queued prefetch when the Link leaves the viewport
// and schedules it again when the Link comes back. Requests already in flight
// still finish.
test("drops queued Link prefetches that left the viewport and retries them on return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const prefetches = await holdPrefetchSlots(page);

  try {
    await page.goto("/prefetch-queue-viewport");
    await waitForAppRouterHydration(page);
    await waitForQueuedPrefetches(page, prefetches.heldTargets);

    await page.locator("#bottom").scrollIntoViewIfNeeded();
    await waitForLinksIntersecting(page, ".queued-link", false);
    const requestedBefore = prefetches.requestedTargets.length;
    prefetches.releaseHeld();
    await waitForQueuedPrefetchesToSettle(page);
    expect(prefetches.requestedTargets.slice(requestedBefore)).toEqual([]);

    await page.evaluate(() => window.scrollTo(0, 0));
    await waitForLinksIntersecting(page, ".queued-link", true);
    await expect.poll(() => new Set(prefetches.requestedTargets).size).toBe(8);
    // Only the queued links are requested again; the held ones were cached.
    for (const target of prefetches.heldTargets) {
      expect(prefetches.requestedTargets.filter((requested) => requested === target)).toHaveLength(
        1,
      );
    }

    const queuedTarget = TARGETS.find((target) => !prefetches.heldTargets.has(target));
    await page.getByRole("link", { name: `Target ${queuedTarget}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: `Target ${queuedTarget}` })).toBeVisible();
  } finally {
    prefetches.releaseHeld();
    await page.unrouteAll({ behavior: "wait" });
  }
});

// Two Links whose hrefs differ only by hash share one prefetch request. It is
// still sent while either of them is visible.
test("sends a shared queued prefetch while another Link using it is still visible", async ({
  page,
}) => {
  // Tall enough that both copies of the links start in the prefetch range.
  await page.setViewportSize({ width: 1280, height: 2400 });
  const prefetches = await holdPrefetchSlots(page);

  try {
    await page.goto("/prefetch-queue-viewport?shared");
    await waitForAppRouterHydration(page);
    await waitForQueuedPrefetches(page, prefetches.heldTargets);

    // Shrink the viewport so only the first copy stays in range.
    await page.setViewportSize({ width: 1280, height: 600 });
    await waitForLinksIntersecting(page, ".shared-link", false);
    await waitForLinksIntersecting(page, ".queued-link", true);
    const requestedBefore = prefetches.requestedTargets.length;
    prefetches.releaseHeld();
    await waitForQueuedPrefetchesToSettle(page);

    const queuedTargets = TARGETS.filter((target) => !prefetches.heldTargets.has(target));
    expect(prefetches.requestedTargets.slice(requestedBefore).sort()).toEqual(queuedTargets);
  } finally {
    prefetches.releaseHeld();
    await page.unrouteAll({ behavior: "wait" });
  }
});

// A Link that leaves the viewport drops its queued prefetch for good. If it
// comes back on a later page, it prefetches again with that page's inputs
// instead of sending the request the previous page queued.
test("re-prefetches with the current page after a persistent Link leaves and returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const prefetches = await holdPrefetchSlots(page);

  try {
    await page.goto("/prefetch-queue-persistent/a");
    await waitForAppRouterHydration(page);
    await waitForQueuedPrefetches(page, prefetches.heldTargets);

    await page.locator("#go-to-b").scrollIntoViewIfNeeded();
    await waitForLinksIntersecting(page, ".persistent-link", false);
    await page.locator("#go-to-b").click();
    await expect(page.getByRole("heading", { name: "Page B" })).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 0));
    await waitForLinksIntersecting(page, ".persistent-link", true);
    const requestedBefore = prefetches.requestedTargets.length;
    prefetches.releaseHeld();

    const queuedTargets = TARGETS.filter((target) => !prefetches.heldTargets.has(target));
    await expect
      .poll(() => [...new Set(prefetches.requestedTargets.slice(requestedBefore))].sort())
      .toEqual(expect.arrayContaining(queuedTargets));
    expect(new Set(prefetches.requestNextUrls.slice(requestedBefore))).toEqual(
      new Set(["/prefetch-queue-persistent/b"]),
    );
  } finally {
    prefetches.releaseHeld();
    await page.unrouteAll({ behavior: "wait" });
  }
});

// A Form prefetches its destination once, when it enters the viewport. It does
// not wait on a Link's queued prefetch for the same route, which the Link
// cancels if it leaves first.
test("prefetches a Form's destination while a Link's prefetch for it is queued", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const prefetches = await holdPrefetchSlots(page);
  const formPrefetches: string[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    const { pathname } = new URL(request.url());
    // Unlike a Link's, the Form's prefetch has no router state headers.
    if (
      pathname.replace(/\.rsc$/, "") === `${TARGET_PREFIX}9` &&
      headers["x-vinext-rsc-render-mode"] === "prefetch-loading-shell" &&
      headers["next-router-prefetch"] === undefined
    ) {
      formPrefetches.push(request.url());
    }
  });

  try {
    await page.goto("/prefetch-queue-viewport?form");
    await waitForAppRouterHydration(page);
    await waitForQueuedPrefetches(page, prefetches.heldTargets);
    expect(prefetches.heldTargets.has("9")).toBe(false);
    expect(formPrefetches).toEqual([]);

    // Bring the Form into range while the Link's prefetch is still queued.
    await page.setViewportSize({ width: 1280, height: 2400 });
    await expect.poll(() => formPrefetches.length).toBe(1);
  } finally {
    prefetches.releaseHeld();
    await page.unrouteAll({ behavior: "wait" });
  }
});
