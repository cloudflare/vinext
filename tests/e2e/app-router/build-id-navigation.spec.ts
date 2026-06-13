import { test, expect, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const VISITED_CACHE_MARKER = "__VINEXT_VISITED_CACHE_MARKER__";
const RSC_NAVIGATION_PROMISE_MARKER = "__VINEXT_TEST_RSC_NAVIGATION_PROMISE__";
const CLIENT_REUSE_MANIFEST_HEADER = "x-vinext-client-reuse-manifest";

async function pushAppRoute(page: Page, pathname: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) {
      throw new Error("window.next.router is not installed");
    }
    // App Router push returns void; Pages Router push returns Promise<boolean>.
    // The union surface flags this as a possibly-floating promise — we don't
    // need the resolution here so explicitly void it.
    void router.push(target);
  }, pathname);
}

async function captureRscNavigationPromises(page: Page): Promise<void> {
  await page.evaluate((marker) => {
    type TestNavigate = (
      href: string,
      redirectDepth?: number,
      navigationKind?: "navigate" | "refresh" | "prefetch",
      historyUpdateMode?: "push" | "replace",
      previousNextUrlOverride?: string | null,
      programmaticTransition?: boolean,
    ) => Promise<unknown>;
    const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime")) as
      | { functions?: { navigate?: TestNavigate } }
      | undefined;
    const navigate = runtime?.functions?.navigate ?? null;
    if (typeof navigate !== "function") {
      throw new Error("App Router navigation runtime is not installed");
    }

    const wrappedNavigate: TestNavigate = (
      href,
      redirectDepth,
      navigationKind,
      historyUpdateMode,
      previousNextUrlOverride,
      programmaticTransition,
    ) => {
      const pendingNavigation = navigate(
        href,
        redirectDepth,
        navigationKind,
        historyUpdateMode,
        previousNextUrlOverride,
        programmaticTransition,
      );
      Reflect.set(window, marker, pendingNavigation);
      return pendingNavigation;
    };

    if (!runtime?.functions) {
      throw new Error("App Router navigation runtime functions are not installed");
    }
    runtime.functions.navigate = wrappedNavigate;
  }, RSC_NAVIGATION_PROMISE_MARKER);
}

async function waitForLastRscNavigation(page: Page): Promise<void> {
  await page.waitForFunction(
    (marker) => Reflect.get(window, marker),
    RSC_NAVIGATION_PROMISE_MARKER,
  );
  await page.evaluate(async (marker) => {
    await Reflect.get(window, marker);
  }, RSC_NAVIGATION_PROMISE_MARKER);
}

test.describe("App Router RSC compatibility navigation", () => {
  test("sends a client reuse manifest for retained static layouts on soft navigation", async ({
    page,
  }) => {
    const manifestHeaders: string[] = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, "/client-nav-test")) {
        const manifestHeader = request.headers()[CLIENT_REUSE_MANIFEST_HEADER];
        if (manifestHeader) {
          manifestHeaders.push(manifestHeader);
        }
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await captureRscNavigationPromises(page);

    const rscResponsePromise = page.waitForResponse(
      (response) =>
        isAppRouterRscRequestForPath(response.request(), "/client-nav-test") &&
        response.request().headers()[CLIENT_REUSE_MANIFEST_HEADER] !== undefined,
    );

    await pushAppRoute(page, "/client-nav-test");
    await expect(page.locator("h1")).toHaveText("Client Nav Test");
    const rscResponse = await rscResponsePromise;
    await waitForLastRscNavigation(page);

    expect(rscResponse.headers()["cache-control"]).toBe("no-store, must-revalidate");
    expect(manifestHeaders).toHaveLength(1);
    const manifest = JSON.parse(manifestHeaders[0]!) as {
      entries: Array<{ id: string; privacy: string }>;
      replayWindow: {
        validFromVisibleCommitVersion: number;
        validUntilVisibleCommitVersion: number;
      };
      visibleCommitVersion: number;
    };
    expect(manifest.visibleCommitVersion).toBe(0);
    expect(manifest.replayWindow).toEqual({
      validFromVisibleCommitVersion: 0,
      validUntilVisibleCommitVersion: 0,
    });
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "layout:/",
          privacy: "public",
        }),
      ]),
    );
    expect(manifest.entries.every((entry) => entry.id.startsWith("layout:"))).toBe(true);
    expect(manifestHeaders[0]!.length).toBeLessThanOrEqual(4096);
  });

  test("refetches unproofed same-build visited RSC payloads instead of reloading", async ({
    page,
  }) => {
    const aboutRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, "/about")) {
        aboutRscRequests.push(request.url());
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await captureRscNavigationPromises(page);

    await pushAppRoute(page, "/about");
    await expect(page.locator("h1")).toHaveText("About");
    // router.push commits visible UI before the RSC navigation promise has
    // finished its post-commit cache-store eligibility check.
    await waitForLastRscNavigation(page);
    expect(aboutRscRequests).toHaveLength(1);

    await page.evaluate((marker) => {
      Reflect.set(window, marker, true);
      const router = window.next?.router;
      if (!router) {
        throw new Error("window.next.router is not installed");
      }
      // App Router push returns void; Pages Router push returns Promise<boolean>.
      // The union surface flags this as a possibly-floating promise — we don't
      // need the resolution here so explicitly void it.
      void router.push("/");
    }, VISITED_CACHE_MARKER);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForLastRscNavigation(page);

    await pushAppRoute(page, "/about");
    await expect(page.locator("h1")).toHaveText("About");

    // Until a real cache proof producer exists, unproofed responses must not be
    // restored as commit-capable visited-cache entries. The marker proves this
    // stayed a soft navigation rather than degrading to an MPA reload.
    await expect(
      page.evaluate((marker) => Reflect.get(window, marker), VISITED_CACHE_MARKER),
    ).resolves.toBe(true);
    expect(aboutRscRequests).toHaveLength(2);
  });
});
