import { test, expect, type Page } from "@playwright/test";
import {
  isAppRouterRscRequestForPath,
  isAppRouterServerActionRequestForPath,
  waitForAppRouterHydration,
} from "../helpers";

const BASE = "http://localhost:4174";
const FEED_DRAFT_VALUE = "source draft survives";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fillFeedSourceState(page: Page, value: string = FEED_DRAFT_VALUE): Promise<void> {
  await expect(page.getByTestId("feed-draft-input")).toBeVisible();
  await page.getByTestId("feed-draft-input").fill(value);
}

async function expectFeedSourceState(
  page: Page,
  options: { draft?: string; tab?: string } = {},
): Promise<void> {
  await expect(page.getByTestId("feed-draft-input")).toHaveValue(options.draft ?? FEED_DRAFT_VALUE);
  await expect(page.getByTestId("feed-tab-state")).toHaveText(`tab:${options.tab ?? "default"}`);
}

test.describe("Parallel Routes", () => {
  test("dashboard renders all parallel slot content", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);

    // Dashboard layout
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout > nav span")).toHaveText("Dashboard Nav");

    // Main children
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // @team parallel slot
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();

    // @analytics parallel slot
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();
  });

  test("child route renders default.tsx fallbacks for inherited slots", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/settings`);

    // Dashboard layout should still be present
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Settings");

    // Parallel slots should render their default.tsx components
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();

    // Should NOT contain the slot page.tsx content
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });

  test("soft navigation preserves active parallel slot content over target defaults", async ({
    page,
  }) => {
    await page.goto(`${BASE}/dashboard`);
    await waitForAppRouterHydration(page);

    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();

    await page.click('[data-testid="dash-settings-link"]');
    await expect(page).toHaveURL(`${BASE}/dashboard/settings`);
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-default"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).not.toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });

  test("soft navigation preserves the active children branch over target defaults", async ({
    page,
  }) => {
    // Ported from Next.js: test/e2e/app-dir/parallel-routes-layouts/parallel-routes-layouts.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-layouts/parallel-routes-layouts.test.ts
    await page.goto(`${BASE}/parallel-layouts`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("parallel-layouts-children")).toHaveText("Primary page");
    await expect(page.getByTestId("parallel-layouts-foo-page")).toBeVisible();
    await expect(page.getByTestId("parallel-layouts-bar-page")).toBeVisible();

    await page.getByTestId("parallel-layouts-subroute-link").click();
    await expect(page).toHaveURL(`${BASE}/parallel-layouts/subroute`);
    await expect(page.getByTestId("parallel-layouts-bar-subroute")).toBeVisible();
    await expect(page.getByTestId("parallel-layouts-children")).toHaveText("Primary page");
    await expect(page.getByTestId("parallel-layouts-foo-page")).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("parallel-layouts-children")).toHaveText("Default page");
    await expect(page.getByTestId("parallel-layouts-foo-default")).toBeVisible();
    await expect(page.getByTestId("parallel-layouts-foo-layout")).not.toBeVisible();
  });

  test("soft navigation preserves a real children route for a slot-only target", async ({
    page,
  }) => {
    await page.goto(`${BASE}/parallel-layouts/settings`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("parallel-layouts-settings-page")).toBeVisible();

    await page.getByTestId("parallel-layouts-modal-link").click();
    await expect(page).toHaveURL(`${BASE}/parallel-layouts/modal`);
    await expect(page.getByTestId("parallel-layouts-bar-modal")).toBeVisible();
    await expect(page.getByTestId("parallel-layouts-settings-page")).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("parallel-layouts-children")).toHaveText("Default page");
  });

  test("slot directories are not accessible as direct routes", async ({ page }) => {
    const response = await page.goto(`${BASE}/dashboard/team`);
    expect(response?.status()).toBe(404);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-leaf-segments/parallel-routes-leaf-segments.no-build-error.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-leaf-segments/parallel-routes-leaf-segments.no-build-error.test.ts
  test("slot-only leaf route renders the children default", async ({ page }) => {
    await page.goto(`${BASE}/parallel-leaf-default/other`);

    await expect(page.getByTestId("parallel-leaf-slot")).toHaveText("Parallel leaf other slot");
    await expect(page.getByTestId("parallel-leaf-children")).toHaveText(
      "Parallel leaf children default",
    );
  });
});

test.describe("Intercepting Routes", () => {
  // Ported and strengthened from Next.js intercepted route coverage:
  // - test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  //   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  // - test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
  //   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
  // - test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
  //   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
  test("direct navigation to photo shows full page", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator("h1")).toContainText("Photo");
    await expect(page.locator('[data-testid="photo-page"]')).toContainText("Full photo view");
    // Should NOT contain modal
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("direct payload cache does not override intercepted navigation", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();

    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  for (const [linkId, encodedId, expectedId] of [
    ["feed-photo-double-encoded-link", "%2561", "%2561"],
    ["feed-photo-encoded-slash-link", "a%2Fb", "a%2Fb"],
    ["feed-photo-unicode-link", "%e2%9c%93", "%E2%9C%93"],
  ] as const) {
    test(`intercepted navigation preserves canonical App Page param ${encodedId}`, async ({
      page,
    }) => {
      await page.goto(`${BASE}/feed`);
      await waitForAppRouterHydration(page);

      await page.click(`#${linkId}`);

      await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
      await expect(page.locator('[data-testid="photo-modal"]')).toContainText(
        `Viewing photo ${expectedId} in modal`,
      );
    });
  }

  test("intercepted payload cache is reused for repeated source-page navigations", async ({
    page,
  }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();

    await page.goto(`${BASE}/about`);
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("chained intercepted navigations keep the original source context", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");
    await expectFeedSourceState(page);

    await page.click("#modal-photo-43-link");

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 43");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("refresh after chained intercepted navigation keeps the proven source context", async ({
    page,
  }) => {
    // Same user-visible contract as Next.js intercepted refresh coverage:
    // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");
    await expectFeedSourceState(page);

    await page.click("#modal-photo-43-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 43");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();

    await page.click('[data-testid="photo-modal-refresh"]');

    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 43");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/photos/43");
  });

  test("intercepted navigation preserves source search and client state", async ({ page }) => {
    await page.goto(`${BASE}/feed?tab=popular`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");

    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page, { tab: "popular" });
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("refresh on direct photo load preserves the full-page render", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("refresh on direct target clears stale intercepted history context", async ({ page }) => {
    const refreshInterceptionHeaders: Array<string | null> = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, "/photos/42")) {
        refreshInterceptionHeaders.push(request.headers()["x-vinext-interception-context"] ?? null);
      }
    });

    await page.goto(`${BASE}/photos/42`);
    await waitForAppRouterHydration(page);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();

    await page.evaluate(() => {
      const currentState = window.history.state;
      const nextState =
        currentState && typeof currentState === "object" ? Object.assign({}, currentState) : {};
      Reflect.set(nextState, "__vinext_previousNextUrl", "/feed");

      const clientNavigationState = Reflect.get(window, Symbol.for("vinext.clientNavigationState"));
      const originalReplaceState =
        clientNavigationState && typeof clientNavigationState === "object"
          ? Reflect.get(clientNavigationState, "originalReplaceState")
          : null;

      if (typeof originalReplaceState !== "function") {
        throw new Error("Expected Vinext original history.replaceState to be installed");
      }

      originalReplaceState.call(window.history, nextState, "", window.location.href);
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const currentState = window.history.state;
          if (!currentState || typeof currentState !== "object") return null;
          const value = Reflect.get(currentState, "__vinext_previousNextUrl");
          return typeof value === "string" ? value : null;
        }),
      )
      .toBe("/feed");

    await page.evaluate(async () => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const navigate =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "navigate" in runtime.functions &&
        typeof runtime.functions.navigate === "function"
          ? runtime.functions.navigate
          : null;
      if (typeof navigate !== "function") {
        throw new Error("Expected Vinext RSC navigation executor to be installed");
      }
      await navigate(window.location.href, 0, "refresh", undefined, undefined, true);
    });

    await expect.poll(() => refreshInterceptionHeaders.length).toBeGreaterThan(0);
    expect(refreshInterceptionHeaders.at(-1)).toBeNull();
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const currentState = window.history.state;
          if (!currentState || typeof currentState !== "object") return null;
          const value = Reflect.get(currentState, "__vinext_previousNextUrl");
          return typeof value === "string" ? value : null;
        }),
      )
      .toBeNull();
  });

  test("hard reload after intercepted navigation renders the full page", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).not.toBeVisible();
  });

  test("router.refresh preserves intercepted modal view", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expectFeedSourceState(page);

    await page.click('[data-testid="photo-modal-refresh"]');

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("server action from intercepted modal preserves modal tree", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);

    const likesLocator = page.locator('[data-testid="photo-likes"]');
    const baselineText = (await likesLocator.textContent()) ?? "";
    const baseline = Number.parseInt(baselineText, 10);
    expect(Number.isFinite(baseline)).toBe(true);

    await page.click('[data-testid="photo-like-btn"]');

    // Wait for the count to change before asserting — avoids a timing race
    // between action fetch and client state update.
    await expect.poll(async () => (await likesLocator.textContent()) ?? "").not.toBe(baselineText);

    const afterText = (await likesLocator.textContent()) ?? "";
    const after = Number.parseInt(afterText, 10);
    expect(after).toBe(baseline + 1);

    // Critical parity assertion: the server-action rerender must keep the
    // intercepted tree mounted — modal visible, source feed layout intact,
    // direct /photos/[id] page NOT rendered, URL unchanged.
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/photos/42");

    // Sanity: a hard refresh still routes to the direct page, mirroring the
    // final assertion in the Next.js reference test.
    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("router.refresh refreshes every active intercepted parallel branch", async ({ page }) => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expectFeedSourceState(page);

    const feedRenderToken = await page.getByTestId("feed-render-token").textContent();
    const modalRenderToken = await page.getByTestId("photo-modal-render-token").textContent();

    await page.click('[data-testid="photo-modal-refresh"]');

    await expect(page.getByTestId("feed-render-token")).not.toHaveText(feedRenderToken ?? "");
    await expect(page.getByTestId("photo-modal-render-token")).not.toHaveText(
      modalRenderToken ?? "",
    );
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("router.refresh refreshes a persisted modal and the active children slot", async ({
    page,
  }) => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    await page.goto(`${BASE}/parallel-refresh`);
    await waitForAppRouterHydration(page);

    const initialPageToken = await page.getByTestId("parallel-refresh-page-token").textContent();
    await page.getByRole("link", { name: "Open login" }).click();
    await expect(page.getByTestId("parallel-refresh-login-modal")).toBeVisible();
    const initialModalToken = await page.getByTestId("parallel-refresh-modal-token").textContent();

    await page
      .getByTestId("parallel-refresh-login-modal")
      .getByTestId("parallel-refresh-button")
      .click();

    await expect(page.getByTestId("parallel-refresh-page-token")).not.toHaveText(
      initialPageToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-modal-token")).not.toHaveText(
      initialModalToken ?? "",
    );

    await page.getByRole("link", { name: "Other page" }).click();
    await expect(page.getByTestId("parallel-refresh-other-page")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-login-modal")).toBeVisible();
    const persistedModalToken = await page
      .getByTestId("parallel-refresh-modal-token")
      .textContent();
    const initialOtherToken = await page.getByTestId("parallel-refresh-other-token").textContent();

    await page
      .getByTestId("parallel-refresh-other-page")
      .getByTestId("parallel-refresh-button")
      .click();

    await expect(page.getByTestId("parallel-refresh-modal-token")).not.toHaveText(
      persistedModalToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-other-token")).not.toHaveText(
      initialOtherToken ?? "",
    );
  });

  test("router.refresh refreshes a persisted dynamic modal with current search params", async ({
    page,
  }) => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    await page.goto(`${BASE}/parallel-refresh-dynamic/foo`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Open dynamic login" }).click();
    await expect(page.getByTestId("parallel-refresh-dynamic-login-modal")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-dynamic-modal-slug")).toHaveText("foo");
    await expect(page.getByTestId("parallel-refresh-dynamic-modal-search")).toHaveText("modal");

    await page.getByRole("link", { name: "Other dynamic page" }).click();
    await expect(page.getByTestId("parallel-refresh-dynamic-other-page")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-dynamic-login-modal")).toBeVisible();
    const initialModalToken = await page
      .getByTestId("parallel-refresh-dynamic-modal-token")
      .textContent();
    const initialOtherToken = await page
      .getByTestId("parallel-refresh-dynamic-other-token")
      .textContent();

    await page
      .getByTestId("parallel-refresh-dynamic-other-page")
      .getByTestId("parallel-refresh-button")
      .click();

    await expect(page.getByTestId("parallel-refresh-dynamic-modal-token")).not.toHaveText(
      initialModalToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-dynamic-other-token")).not.toHaveText(
      initialOtherToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-dynamic-modal-search")).toHaveText("other");
  });

  test("router.refresh refreshes multiple persisted intercepted slots", async ({ page }) => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
    await page.goto(`${BASE}/parallel-refresh-multiple`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Open drawer" }).click();
    await expect(page.getByTestId("parallel-refresh-multiple-drawer")).toBeVisible();
    await page.getByRole("link", { name: "Open modal" }).click();
    await expect(page.getByTestId("parallel-refresh-multiple-modal")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-multiple-drawer")).toBeVisible();
    await page.getByRole("link", { name: "Multiple other page" }).click();
    await expect(page.getByTestId("parallel-refresh-multiple-other-page")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-multiple-modal")).toBeVisible();
    await expect(page.getByTestId("parallel-refresh-multiple-drawer")).toBeVisible();

    const initialDrawerToken = await page
      .getByTestId("parallel-refresh-multiple-drawer-token")
      .textContent();
    const initialModalToken = await page
      .getByTestId("parallel-refresh-multiple-modal-token")
      .textContent();
    const initialOtherToken = await page
      .getByTestId("parallel-refresh-multiple-other-token")
      .textContent();

    await page
      .getByTestId("parallel-refresh-multiple-other-page")
      .getByTestId("parallel-refresh-button")
      .click();

    await expect(page.getByTestId("parallel-refresh-multiple-drawer-token")).not.toHaveText(
      initialDrawerToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-multiple-modal-token")).not.toHaveText(
      initialModalToken ?? "",
    );
    await expect(page.getByTestId("parallel-refresh-multiple-other-token")).not.toHaveText(
      initialOtherToken ?? "",
    );
  });

  test("router.refresh recovers when a persisted slot refresh fails", async ({ page }) => {
    await page.goto(`${BASE}/refreshing`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Open refreshing login" }).click();
    await expect(page.getByTestId("refreshing-login-modal")).toBeVisible();
    await page.getByRole("link", { name: "Go to Other Page" }).click();
    await expect(page.getByTestId("refreshing-other-page")).toBeVisible();

    const modalToken = await page.getByTestId("refreshing-modal-token").textContent();
    const otherToken = await page.getByTestId("refreshing-other-token").textContent();
    let supplementalRequests = 0;
    await page.route("**/*", async (route) => {
      if (isAppRouterRscRequestForPath(route.request(), "/refreshing/login")) {
        supplementalRequests++;
        if (supplementalRequests === 1) {
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });

    await page
      .getByTestId("refreshing-other-page")
      .getByRole("button", { name: "Refresh", exact: true })
      .click();

    // The primary refresh still commits after the supplemental request fails.
    await expect(page.getByTestId("refreshing-other-token")).not.toHaveText(otherToken ?? "");
    // A bounded recovery refresh must retry the stale persisted slot.
    await expect.poll(() => supplementalRequests).toBe(2);
    await expect(page.getByTestId("refreshing-modal-token")).not.toHaveText(modalToken ?? "");
  });

  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  for (const fixture of [
    {
      basePath: "/refreshing",
      label: "regular",
      modalTestId: "refreshing-login-modal",
      modalTokenTestId: "refreshing-modal-token",
      otherTokenTestId: "refreshing-other-token",
      pageTokenTestId: "refreshing-page-token",
      searchPrefix: "refreshing",
    },
    {
      basePath: "/dynamic-refresh/foo",
      label: "dynamic",
      modalTestId: "dynamic-refresh-login-modal",
      modalTokenTestId: "dynamic-refresh-modal-token",
      otherTokenTestId: "dynamic-refresh-other-token",
      pageTokenTestId: "dynamic-refresh-page-token",
      searchPrefix: "dynamic-refresh",
    },
  ]) {
    for (const withSearchParams of [false, true]) {
      test(`router.refresh (${fixture.label}) - searchParams: ${withSearchParams} refreshes intercepted and source slots`, async ({
        page,
      }) => {
        await page.goto(`${BASE}${fixture.basePath}`);
        await waitForAppRouterHydration(page);

        if (withSearchParams) {
          await page
            .getByRole("button", { name: `Update ${fixture.searchPrefix}-page search params` })
            .click();
          await expect(
            page.getByTestId(`${fixture.searchPrefix}-page-search-params`),
          ).toContainText("0.");
        }

        const pageToken = await page.getByTestId(fixture.pageTokenTestId).textContent();
        await page.getByRole("link", { name: /Open .*refreshing login/ }).click();
        await expect(page.getByTestId(fixture.modalTestId)).toBeVisible();
        const modalToken = await page.getByTestId(fixture.modalTokenTestId).textContent();

        await page
          .getByTestId(fixture.modalTestId)
          .getByRole("button", { name: "Refresh", exact: true })
          .click();

        await expect(page.getByTestId(fixture.pageTokenTestId)).not.toHaveText(pageToken ?? "");
        await expect(page.getByTestId(fixture.modalTokenTestId)).not.toHaveText(modalToken ?? "");
        await expect(page.getByTestId(fixture.modalTestId)).toBeVisible();
      });

      test(`server revalidation (${fixture.label}) - searchParams: ${withSearchParams} refreshes persisted and active slots`, async ({
        page,
      }) => {
        await page.goto(`${BASE}${fixture.basePath}`);
        await waitForAppRouterHydration(page);

        if (withSearchParams) {
          await page
            .getByRole("button", { name: `Update ${fixture.searchPrefix}-page search params` })
            .click();
          await expect(
            page.getByTestId(`${fixture.searchPrefix}-page-search-params`),
          ).toContainText("0.");
        }

        await page.getByRole("link", { name: /Open .*refreshing login/ }).click();
        await expect(page.getByTestId(fixture.modalTestId)).toBeVisible();
        await page.getByRole("link", { name: /Go to (Dynamic )?Other Page/ }).click();
        const modalToken = await page.getByTestId(fixture.modalTokenTestId).textContent();
        const otherToken = await page.getByTestId(fixture.otherTokenTestId).textContent();

        await page.getByRole("main").getByRole("button", { name: "Revalidate" }).click();

        await expect(page.getByTestId(fixture.modalTokenTestId)).not.toHaveText(modalToken ?? "");
        await expect(page.getByTestId(fixture.otherTokenTestId)).not.toHaveText(otherToken ?? "");
        await expect(page.getByTestId(fixture.modalTestId)).toBeVisible();
      });
    }
  }

  test("serializes actions behind an earlier detached supplemental commit", async ({ page }) => {
    await page.goto(`${BASE}/refreshing`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Open refreshing login" }).click();
    await expect(page.getByTestId("refreshing-login-modal")).toBeVisible();
    await page.getByRole("link", { name: "Go to Other Page" }).click();
    await expect(page.getByTestId("refreshing-other-page")).toBeVisible();

    let actionPosts = 0;
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") actionPosts++;
      await route.continue();
    });
    const supplementalRequested = deferred();
    const releaseSupplemental = deferred();
    await page.route("**/refreshing/login**", async (route) => {
      supplementalRequested.resolve();
      await releaseSupplemental.promise;
      await route.continue();
    });

    const initialModalToken = await page.getByTestId("refreshing-modal-token").textContent();
    const initialOtherToken = await page.getByTestId("refreshing-other-token").textContent();
    await page.getByTestId("serialized-revalidate").click();
    await supplementalRequested.promise;
    await expect(page.getByTestId("serialized-revalidate-status")).toHaveText("A resolved");
    expect(actionPosts).toBe(1);

    releaseSupplemental.resolve();
    await expect(page.getByTestId("serialized-revalidate-status")).toHaveText("B resolved");
    expect(actionPosts).toBe(2);
    await expect(page.getByTestId("refreshing-modal-token")).not.toHaveText(
      initialModalToken ?? "",
    );
    await expect(page.getByTestId("refreshing-other-token")).not.toHaveText(
      initialOtherToken ?? "",
    );
    await expect(page.getByTestId("refreshing-login-modal")).toBeVisible();
    await expect(page.getByTestId("refreshing-other-page")).toBeVisible();
  });

  test("recovers a preempted revalidating action before continuing the queued action", async ({
    page,
  }) => {
    // Ported from Next.js's discarded revalidating action coverage, extended to
    // cover a queued action behind the detached commit:
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/actions/app-action.test.ts
    await page.goto(`${BASE}/refreshing`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Open refreshing login" }).click();
    await expect(page.getByTestId("refreshing-login-modal")).toBeVisible();
    await page.getByRole("link", { name: "Go to Other Page" }).click();
    await expect(page.getByTestId("refreshing-other-page")).toBeVisible();

    const supplementalRequested = deferred();
    const releaseSupplemental = deferred();
    const navigationRequested = deferred();
    const releaseNavigation = deferred();
    const recoveryRequested = deferred();
    const releaseRecovery = deferred();
    let actionPosts = 0;
    let refreshingRequests = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST") actionPosts++;

      if (isAppRouterRscRequestForPath(request, "/refreshing/login")) {
        supplementalRequested.resolve();
        await releaseSupplemental.promise;
      } else if (isAppRouterRscRequestForPath(request, "/refreshing")) {
        refreshingRequests++;
        if (refreshingRequests === 1) {
          navigationRequested.resolve();
          await releaseNavigation.promise;
        } else if (refreshingRequests === 2) {
          recoveryRequested.resolve();
          await releaseRecovery.promise;
        }
      }
      await route.continue();
    });

    await page.getByTestId("serialized-revalidate").click();
    await supplementalRequested.promise;
    await expect(page.getByTestId("serialized-revalidate-status")).toHaveText("A resolved");
    expect(actionPosts).toBe(1);

    await page.getByRole("link", { name: "Go to Refreshing Page" }).click();
    await navigationRequested.promise;
    releaseSupplemental.resolve();
    releaseNavigation.resolve();

    await recoveryRequested.promise;
    await expect(page.getByTestId("refreshing-page-token")).toBeVisible();
    const recoveryToken = await page.getByTestId("refreshing-page-token").textContent();
    expect(actionPosts).toBe(1);

    releaseRecovery.resolve();
    await expect.poll(() => actionPosts).toBe(2);
    await expect(page.getByTestId("refreshing-page-token")).not.toHaveText(recoveryToken ?? "");
    expect(refreshingRequests).toBe(2);
  });

  test("revalidating server action from dynamic intercepted modal returns a result", async ({
    page,
  }) => {
    // Ported from Next.js: test/e2e/app-dir/dynamic-interception-route-revalidate/dynamic-interception-route-revalidate.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-interception-route-revalidate/dynamic-interception-route-revalidate.test.ts
    await page.goto(`${BASE}/dynamic-interception-revalidate/en`);
    await waitForAppRouterHydration(page);

    await page.click("[href='/dynamic-interception-revalidate/en/photos/1/view']");
    await expect(page.locator("#dynamic-interception-revalidate-intercepted")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Photo Id: 1");

    const actionRequest = page.waitForRequest((request) =>
      isAppRouterServerActionRequestForPath(
        request,
        "/dynamic-interception-revalidate/en/photos/1/view",
      ),
    );
    await page.click("#dynamic-interception-revalidate-button");
    expect((await actionRequest).headers()["x-vinext-interception-context"]).toBe(
      "/dynamic-interception-revalidate/en",
    );
    await expect(page.locator("#dynamic-interception-revalidate-loading")).toBeVisible();
    await expect(page.locator("#dynamic-interception-revalidate-result")).toHaveText("Result: 0");

    await expect(page.locator("#dynamic-interception-revalidate-intercepted")).toBeVisible();
    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator("#dynamic-interception-revalidate-intercepted")).not.toBeVisible();
    await expect(page.locator("#dynamic-interception-revalidate-full")).toBeVisible();
  });

  test("sibling (..) intercepted navigation mounts the modal slot", async ({ page }) => {
    // Ported from the sibling-interception behavior covered by Next.js:
    // test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    await page.goto(`${BASE}/sibling-source`);
    await waitForAppRouterHydration(page);

    await page.click("#sibling-target-42-link");

    await page.waitForURL(`${BASE}/sibling-target/42`);
    await expect(page.locator('[data-testid="sibling-source-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="sibling-target-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="sibling-target-modal-id"]')).toContainText(
      "target-id:42",
    );
    await expect(page.locator('[data-testid="sibling-target-page"]')).not.toBeVisible();
  });

  test("top-level sibling (..) film navigation mounts the modal slot", async ({ page }) => {
    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.click("#godfather-film-link");

    await page.waitForURL(`${BASE}/film/tt0068646-the-godfather-1972`);
    await expect(page.locator('[data-testid="top-page"]')).toBeVisible();
    await expect(page.locator("h1")).toContainText("Top 1000");
    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="film-panel-id"]')).toContainText(
      "tt0068646-the-godfather-1972",
    );
    await expect(page.locator('[data-testid="detail-page"]')).not.toBeVisible();
  });

  test("sibling (..) modal preserves source content in a parallel feed slot", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception/app/(group)/intercepting-parallel-modal
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/parallel-routes-and-interception/app/(group)/intercepting-parallel-modal
    await page.goto(`${BASE}/parallel-sibling-modal/vercel`);
    await waitForAppRouterHydration(page);

    await page.click("#parallel-photo-42-link");

    await page.waitForURL(`${BASE}/parallel-sibling-modal/photo/42`);
    await expect(page.locator('[data-testid="parallel-feed-page"]')).toContainText(
      "Feed for vercel",
    );
    await expect(page.locator('[data-testid="parallel-photo-modal"]')).toHaveText("Photo MODAL 42");
    await expect(page.locator('[data-testid="parallel-photo-page"]')).not.toBeVisible();
  });

  test("direct navigation to slot-only parallel source route renders feed slot", async ({
    page,
  }) => {
    await page.goto(`${BASE}/parallel-sibling-modal/vercel`);

    await expect(page.locator('[data-testid="parallel-sibling-layout"]')).toBeVisible();
    await expect(page.locator('[data-testid="parallel-feed-page"]')).toContainText(
      "Feed for vercel",
    );
    await expect(page.locator('[data-testid="parallel-modal-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="parallel-photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="parallel-photo-page"]')).not.toBeVisible();
  });

  test("back then forward restores intercepted modal view", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await fillFeedSourceState(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);

    await page.goBack();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);

    await page.goForward();
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expectFeedSourceState(page);
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("cache-miss traversal from an intercepted route uses the target history authority", async ({
    page,
  }) => {
    const traversalRscPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.headers()["rsc"] === "1" && url.searchParams.has("_rsc")) {
        traversalRscPaths.push(url.pathname);
      }
    });

    await page.goto(`${BASE}/about`);
    await waitForAppRouterHydration(page);
    await page.evaluate(async () => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const navigate =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "navigate" in runtime.functions &&
        typeof runtime.functions.navigate === "function"
          ? runtime.functions.navigate
          : null;
      if (navigate === null) throw new Error("Expected Vinext RSC navigation executor");
      await navigate("/feed", 0, "navigate", "push", undefined, true);
    });
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.evaluate(() => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const clearNavigationCaches =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "clearNavigationCaches" in runtime.functions &&
        typeof runtime.functions.clearNavigationCaches === "function"
          ? runtime.functions.clearNavigationCaches
          : null;
      if (clearNavigationCaches === null) {
        throw new Error("Expected Vinext navigation cache invalidation");
      }
      clearNavigationCaches();
    });
    traversalRscPaths.length = 0;

    await page.evaluate(() => window.history.go(-2));
    await page.waitForURL(`${BASE}/about`);

    await expect(page.locator("#app-page")).toHaveText("About");
    await expect(page.locator('[data-testid="feed-page"]')).not.toBeVisible();
    await expect.poll(() => traversalRscPaths).toContain("/about");
    expect(traversalRscPaths).not.toContain("/feed");
  });
});

test.describe("Route Segment Config", () => {
  test("force-dynamic page returns no-store Cache-Control", async ({ page }) => {
    const response = await page.goto(`${BASE}/dynamic-test`);
    const headers = response?.headers();
    expect(headers?.["cache-control"]).toContain("no-store");
    await expect(page.locator('[data-testid="dynamic-test-page"]')).toBeVisible();
  });

  test("dynamicParams=false returns 404 for unknown params", async ({ page }) => {
    const response = await page.goto(`${BASE}/products/999`);
    expect(response?.status()).toBe(404);
  });

  test("dynamicParams=false allows known params", async ({ page }) => {
    await page.goto(`${BASE}/products/1`);
    await expect(page.locator('[data-testid="product-page"]')).toBeVisible();
  });
});

test.describe("Template", () => {
  test("root template wraps all pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });

  test("root template is present on sub-pages", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });
});

test.describe("Viewport Metadata", () => {
  test("viewport exports render as meta tags", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    // Theme color should be rendered
    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute("content", "#0070f3");

    // Color scheme should be rendered
    const colorScheme = page.locator('meta[name="color-scheme"]');
    await expect(colorScheme).toHaveAttribute("content", "light dark");
  });
});

test.describe("Shallow Routing (history.pushState/replaceState)", () => {
  test("pushState updates useSearchParams", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    // Wait for hydration
    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Initially no search params
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: ");

    // Click pushState button to set filter=active
    await page.locator('[data-testid="push-filter"]').click({ noWaitAfter: true });

    // useSearchParams should react to the URL change
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });

    // URL should be updated
    await expect
      .poll(() => page.url(), { timeout: 10_000 })
      .toContain("/shallow-test?filter=active");
  });

  test("replaceState updates useSearchParams without adding history entry", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Replace with sort=name
    await page.locator('[data-testid="replace-sort"]').click({ noWaitAfter: true });

    await expect(page.locator('[data-testid="search"]')).toHaveText("search: sort=name", {
      timeout: 10_000,
    });

    // Going back should go to the page before /shallow-test (not to /shallow-test without params)
    // because replaceState replaces the current entry
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/shallow-test?sort=name");
  });

  test("pushState updates usePathname", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Initial pathname
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("pathname: /shallow-test");

    // Push new path
    await page.locator('[data-testid="push-path"]').click({ noWaitAfter: true });

    // usePathname should update
    await expect(page.locator('[data-testid="pathname"]')).toHaveText(
      "pathname: /shallow-test/sub",
      { timeout: 10_000 },
    );
  });

  test.fixme("multiple pushState calls update search params correctly", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Push filter, then combined
    await page.locator('[data-testid="push-filter"]').click({ noWaitAfter: true });
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });

    await page.locator('[data-testid="push-combined"]').click({ noWaitAfter: true });
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: a=1&b=2", {
      timeout: 10_000,
    });

    // Go back should restore previous state
    await page.goBack();
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });
  });
});
