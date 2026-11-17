/**
 * Next.js Compat E2E: actions-revalidate-remount + revalidatetag-rsc
 *
 * Sources:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/revalidatetag-rsc/revalidatetag-rsc.test.ts
 *
 * Tests that revalidatePath via server action refreshes page data,
 * and that router.refresh() re-renders the page with fresh data.
 */

import { test, expect, type Page } from "@playwright/test";
import { isAppRouterServerActionRequestForPath, waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: actions-revalidate (browser)", () => {
  function waitForActionDiscardingResponse(page: Page) {
    return page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), "/nextjs-compat/action-discarding"),
    );
  }

  async function expectActionRefreshPreservesLoading(page: Page, buttonSelector: string) {
    const loadingLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text() === "Action refresh loading mounted") {
        loadingLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-refresh-no-rerender`);
    await waitForAppRouterHydration(page);
    loadingLogs.length = 0;

    const initialValue = await page.locator("#flag-value").textContent();

    await page.click(buttonSelector);

    await expect(async () => {
      const nextValue = await page.locator("#flag-value").textContent();
      expect(nextValue).toBeTruthy();
      expect(nextValue).not.toBe(initialValue);
    }).toPass({ timeout: 10_000 });

    expect(await page.locator("#action-refresh-loading").count()).toBe(0);
    expect(loadingLogs).toEqual([]);
  }

  test("server action followed by router.refresh does not mount route loading", async ({
    page,
  }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh");
  });

  test("refresh() inside server action does not mount route loading", async ({ page }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh-from-server");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "action discarding" coverage. Vinext uses a local counter instead of a
  // remote fetch cache so the assertion is deterministic.
  test("discarded server action without revalidation does not refresh current route", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).toHaveText(initialValue);
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "should trigger a refresh for a server action that gets discarded due to
  // a navigation (with revalidation)".
  test("discarded server action with revalidation refreshes current route", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action-refresh");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
  });

  // Next.js queues a server action dispatched while a navigation is pending
  // and runs it on the navigation's state: it posts from the destination once
  // the navigation is done, and its revalidated tree is applied there.
  test("server action dispatched during a pending navigation runs after it, from the destination", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const destinationPath = "/nextjs-compat/action-discarding/destination";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);
    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    let releaseDestination = () => {};
    const destinationGate = new Promise<void>((resolve) => {
      releaseDestination = resolve;
    });
    let destinationRequested = () => {};
    const destinationRequest = new Promise<void>((resolve) => {
      destinationRequested = resolve;
    });
    await page.route(
      (url) => url.pathname === destinationPath && url.searchParams.has("_rsc"),
      async (route) => {
        destinationRequested();
        const response = await route.fetch();
        await destinationGate;
        await route.fulfill({ response });
      },
    );
    const actionPaths: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
        actionPaths.push(new URL(request.url()).pathname);
      }
    });

    await page.click("#navigate-discard-destination");
    await destinationRequest;
    await page.click("#slow-action-refresh");
    await page.waitForTimeout(300);
    expect(actionPaths).toEqual([]);

    const actionResponse = page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), destinationPath),
    );
    releaseDestination();
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;
    expect(actionPaths).toEqual([destinationPath]);

    await expect(page.locator("#discard-destination")).toBeVisible();
    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
  });

  // A revalidating action answered without a tree (as a forwarded action is)
  // refreshes the current URL, but not over a pending external document load.
  test("revalidating action without a tree does not refresh over a pending external navigation", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const externalUrl = "http://external.example/landing";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);

    let releaseAction = () => {};
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let releaseExternal = () => {};
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    let externalRequested = () => {};
    const externalRequest = new Promise<void>((resolve) => {
      externalRequested = resolve;
    });
    let sourceRscReads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (isAppRouterServerActionRequestForPath(request, sourcePath)) {
        const response = await route.fetch();
        await actionGate;
        // Keep the real headers (revalidated, compatibility id) but drop the tree.
        return route.fulfill({
          status: 200,
          headers: response.headers(),
          body: '0:{"returnValue":{"ok":true,"data":1}}\n',
        });
      }
      if (url.pathname === sourcePath && url.searchParams.has("_rsc")) sourceRscReads += 1;
      if (request.isNavigationRequest() && url.host === "external.example") {
        externalRequested();
        await externalGate;
        return route.fulfill({
          contentType: "text/html",
          body: '<p id="external-landing">External</p>',
        });
      }
      return route.continue();
    });

    const actionResponse = page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), sourcePath),
    );
    await page.click("#slow-action-refresh");
    await page.evaluate((href) => {
      (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(
        href,
      );
    }, externalUrl);
    await externalRequest;

    releaseAction();
    await actionResponse;
    await page.waitForTimeout(500);
    expect(sourceRscReads).toBe(0);

    releaseExternal();
    await expect(page.locator("#external-landing")).toBeVisible();
    expect(page.url()).toBe(externalUrl);
  });

  // A server action's redirect to another origin loads a document. A
  // revalidating action without a tree, still in flight beside it, refreshes
  // the current URL only once that load is gone, not over it.
  test("revalidating action without a tree does not refresh over another action's document load", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const externalUrl = "http://external.example/landing";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);

    let releaseRevalidatingAction = () => {};
    const revalidatingActionGate = new Promise<void>((resolve) => {
      releaseRevalidatingAction = resolve;
    });
    let releaseExternal = () => {};
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    let externalRequested = () => {};
    const externalRequest = new Promise<void>((resolve) => {
      externalRequested = resolve;
    });
    let actionRequests = 0;
    let sourceRscReads = 0;
    const sourceDocumentLoads: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (isAppRouterServerActionRequestForPath(request, sourcePath)) {
        actionRequests += 1;
        const isRevalidatingAction = actionRequests === 1;
        const response = await route.fetch();
        if (isRevalidatingAction) {
          await revalidatingActionGate;
          // Keep the real headers (revalidated, compatibility id) but drop the tree.
          return route.fulfill({
            status: 200,
            headers: response.headers(),
            body: '0:{"returnValue":{"ok":true,"data":1}}\n',
          });
        }
        return route.fulfill({
          status: 200,
          headers: { ...response.headers(), "x-action-redirect": externalUrl },
          body: "",
        });
      }
      if (url.pathname === sourcePath && url.searchParams.has("_rsc")) {
        sourceRscReads += 1;
        // A refresh that falls back loads this page over the external one.
        return route.abort("failed");
      }
      if (request.isNavigationRequest() && url.pathname === sourcePath) {
        sourceDocumentLoads.push(url.href);
      }
      if (request.isNavigationRequest() && url.host === "external.example") {
        externalRequested();
        await externalGate;
        return route.fulfill({
          contentType: "text/html",
          body: '<p id="external-landing">External</p>',
        });
      }
      return route.continue();
    });

    const revalidatingActionRequest = page.waitForRequest((request) =>
      isAppRouterServerActionRequestForPath(request, sourcePath),
    );
    await page.click("#slow-action-refresh");
    await revalidatingActionRequest;
    await page.click("#slow-action");
    await externalRequest;

    const revalidatingActionResponse = page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), sourcePath),
    );
    releaseRevalidatingAction();
    await revalidatingActionResponse;
    await page.waitForTimeout(500);
    expect(sourceRscReads).toBe(0);

    releaseExternal();
    await expect(page.locator("#external-landing")).toBeVisible();
    expect(page.url()).toBe(externalUrl);
    expect(sourceDocumentLoads).toEqual([]);
  });

  // As in Next.js, a navigation that superseded an action discards the
  // action's redirect, even to another origin, and refreshes what it revalidated.
  test("superseded server action's external redirect does not replace the navigation", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const destinationPath = "/nextjs-compat/action-discarding/destination";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);
    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    let releaseAction = () => {};
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let externalLoads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (isAppRouterServerActionRequestForPath(request, sourcePath)) {
        const response = await route.fetch();
        await actionGate;
        // Keep the real headers (revalidated, compatibility id), redirect away.
        return route.fulfill({
          status: 303,
          headers: {
            ...response.headers(),
            "x-action-redirect": "http://external.example/landing",
          },
          body: "",
        });
      }
      if (request.isNavigationRequest() && new URL(request.url()).host === "external.example") {
        externalLoads += 1;
        return route.fulfill({
          contentType: "text/html",
          body: '<p id="external-landing">External</p>',
        });
      }
      return route.continue();
    });

    const actionRequest = page.waitForRequest((request) =>
      isAppRouterServerActionRequestForPath(request, sourcePath),
    );
    await page.click("#slow-action-refresh");
    await actionRequest;
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();

    const actionResponse = waitForActionDiscardingResponse(page);
    releaseAction();
    await actionResponse;
    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    expect(externalLoads).toBe(0);
    expect(new URL(page.url()).pathname).toBe(destinationPath);
    await expect(page.locator("#discard-destination")).toBeVisible();
  });

  // A navigation that falls back to a document load owns what loads next. A
  // discarded action's refresh must wait for that load, not reload the page
  // it was posted from over it.
  test("discarded server action with revalidation does not cancel a pending document load", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const destinationPath = "/nextjs-compat/action-discarding/destination";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);

    let releaseAction = () => {};
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let releaseDestinationDocument = () => {};
    const destinationDocumentGate = new Promise<void>((resolve) => {
      releaseDestinationDocument = resolve;
    });
    let destinationDocumentRequested = () => {};
    const destinationDocumentRequest = new Promise<void>((resolve) => {
      destinationDocumentRequested = resolve;
    });
    const sourceDocumentLoads: string[] = [];

    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (isAppRouterServerActionRequestForPath(request, sourcePath)) {
        const response = await route.fetch();
        await actionGate;
        return route.fulfill({ response });
      }
      // Every RSC fetch fails, so navigations fall back to document loads.
      if (url.searchParams.has("_rsc")) return route.abort("failed");
      if (request.isNavigationRequest() && url.pathname === destinationPath) {
        destinationDocumentRequested();
        await destinationDocumentGate;
        return route.continue();
      }
      if (request.isNavigationRequest() && url.pathname === sourcePath) {
        sourceDocumentLoads.push(url.href);
      }
      return route.continue();
    });

    const actionRequest = page.waitForRequest((request) =>
      isAppRouterServerActionRequestForPath(request, sourcePath),
    );
    await page.click("#slow-action-refresh");
    await actionRequest;
    await page.click("#navigate-discard-destination");
    await destinationDocumentRequest;

    // The action's revalidation lands while the destination document loads.
    const actionResponse = page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), sourcePath),
    );
    releaseAction();
    await actionResponse;
    await page.waitForTimeout(500);
    releaseDestinationDocument();

    await expect(page.locator("#discard-destination")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(destinationPath);
    expect(sourceDocumentLoads).toEqual([]);
  });

  // A document load answered with 204 leaves this document alive without any
  // event. Discarded actions after it must still refresh what they revalidated.
  test("discarded server action refreshes after a document load that left the page alive", async ({
    page,
  }) => {
    const sourcePath = "/nextjs-compat/action-discarding";
    const destinationPath = "/nextjs-compat/action-discarding/destination";
    await page.goto(`${BASE}${sourcePath}`);
    await waitForAppRouterHydration(page);

    let destinationRscReads = 0;
    let destinationDocumentLoads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname !== destinationPath) return route.continue();
      if (url.searchParams.has("_rsc")) {
        destinationRscReads += 1;
        // The first navigation falls back to a document load.
        if (destinationRscReads === 1) return route.abort("failed");
        return route.continue();
      }
      if (request.isNavigationRequest()) {
        destinationDocumentLoads += 1;
        return route.fulfill({ status: 204, body: "" });
      }
      return route.continue();
    });

    await page.click("#navigate-discard-destination");
    await expect.poll(() => destinationDocumentLoads).toBe(1);
    expect(new URL(page.url()).pathname).toBe(sourcePath);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }
    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action-refresh");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
  });

  // Ported from Next.js: test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
  test("revalidating server actions preserve client state under loading.tsx", async ({ page }) => {
    const loadingLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text() === "Action revalidate loading mounted") {
        loadingLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-revalidate`);
    await waitForAppRouterHydration(page);
    loadingLogs.length = 0;

    await page.click("#action-revalidate-increment");
    await page.click("#action-revalidate-increment");
    await page.click("#action-revalidate-increment");
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("3");

    const time1 = await page.locator("#time").textContent();
    const layoutVersion1 = await page.locator("#layout-version").textContent();
    expect(time1).toBeTruthy();
    expect(layoutVersion1).toBeTruthy();

    await page.click("#revalidate");

    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });

    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion1!);

    const layoutVersion2 = await page.locator("#layout-version").textContent();
    expect(layoutVersion2).toBeTruthy();
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("3");
    expect(await page.locator("#action-revalidate-loading").count()).toBe(0);
    expect(loadingLogs).toEqual([]);

    await page.click("#revalidate-tag");
    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion2!);
  });

  // Test router.refresh() re-renders with fresh data
  test("router.refresh() updates page data", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/refresh-test`);
    await waitForAppRouterHydration(page);

    // Read initial timestamp
    const time1 = await page.locator("#time").textContent();
    expect(time1).toBeTruthy();

    // Click refresh button (calls router.refresh())
    await page.click("#refresh");

    // Wait for timestamp to change
    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });
  });
});
