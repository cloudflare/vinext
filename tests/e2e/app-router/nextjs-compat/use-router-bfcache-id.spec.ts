/**
 * Next.js Compat E2E: useRouter().bfcacheId
 * Ported from: https://github.com/vercel/next.js/blob/56d95137fd6d84f4bc1e5ef2bb31e0136d5fad9c/test/e2e/app-dir/use-router-bfcache-id/use-router-bfcache-id.test.ts
 *
 * Next.js also covers Activity-backed form-state preservation on browser back.
 * Vinext does not implement React Activity yet, so form-state-on-back
 * assertions are intentionally omitted here; these tests focus on bfcacheId
 * identity semantics. Same-segment DOM state preservation (e.g. input values
 * surviving search-param navigation) is tested where it works today without
 * Activity.
 */

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/nextjs-compat/use-router-bfcache-id";

async function revealAndClick(page: Page, href: string) {
  await page.locator(`input[data-link-accordion="${href}"]`).first().check();
  await page.locator(`a[href="${href}"]`).first().click();
}

function visibleTestId(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`).first();
}

function waitForServerActionResponse(page: Page, pathname: string) {
  return page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    const responsePathname = new URL(response.url()).pathname;
    return responsePathname === pathname || responsePathname === `${pathname}.rsc`;
  });
}

test.describe("Next.js compat: useRouter().bfcacheId", () => {
  test("mints bfcacheIds for fresh leaf navigations and restores them on history traversal", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText("_b_0_");
    const x1BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    const x2BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(x2BfcacheId).toMatch(/^_b_\d+_$/);
    await expect(visibleTestId(page, "leaf-input")).toHaveValue("");

    await page.goBack();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/1`);
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(x1BfcacheId ?? "");
  });

  test("uses the hydration bfcacheId after hard reload without leaking leaf state on back", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const x1BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(x1BfcacheId).toBe("_b_0_");

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    const x2BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(x2BfcacheId).toMatch(/^_b_\d+_$/);
    expect(x2BfcacheId).not.toBe(x1BfcacheId);

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText("_b_0_");
    const reloadedX2BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await expect(visibleTestId(page, "leaf-bfcache-id")).not.toHaveText(x2BfcacheId ?? "");

    await visibleTestId(page, "leaf-input").fill("x2-state-after-reload");
    await page.goBack();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/1`);
    const postReloadBackBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(postReloadBackBfcacheId).toMatch(/^_b_\d+_$/);
    expect(postReloadBackBfcacheId).not.toBe(x1BfcacheId);
    await expect(visibleTestId(page, "leaf-input")).not.toHaveValue("x2-state-after-reload");

    await page.goForward();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(reloadedX2BfcacheId ?? "");
  });

  test("resets leaf form state when re-entering a route via fresh push", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const initialBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "leaf-input").fill("hello");
    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);

    await revealAndClick(page, `${ROUTE}/x/1`);
    const freshBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(freshBfcacheId).toMatch(/^_b_\d+_$/);
    expect(freshBfcacheId).not.toBe(initialBfcacheId);
    await expect(visibleTestId(page, "leaf-input")).toHaveValue("");
  });

  test("preserves shared layout state across sibling leaf navigations", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await visibleTestId(page, "layout-input").fill("layout");
    const xLayoutBfcacheId = await visibleTestId(page, "layout-bfcache-id").textContent();

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    await expect(visibleTestId(page, "layout-input")).toHaveValue("layout");
    await expect(visibleTestId(page, "layout-bfcache-id")).toHaveText(xLayoutBfcacheId ?? "");
  });

  test("resets shared layout state when navigating across dynamic groups", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await visibleTestId(page, "layout-input").fill("layout");
    const xLayoutBfcacheId = await visibleTestId(page, "layout-bfcache-id").textContent();

    await revealAndClick(page, `${ROUTE}/y/1`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/y/1`);
    await expect(visibleTestId(page, "layout-input")).toHaveValue("");
    const yLayoutBfcacheId = await visibleTestId(page, "layout-bfcache-id").textContent();
    expect(yLayoutBfcacheId).not.toBe(xLayoutBfcacheId);
  });

  test("preserves bfcacheId across hash/search-param navigation and refresh", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const initialBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "leaf-input").fill("same-segment-state");
    await revealAndClick(page, `${ROUTE}/x/1#section`);
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");

    await revealAndClick(page, `${ROUTE}/x/1?q=2`);
    await expect(visibleTestId(page, "search")).toHaveAttribute("data-value", "q=2");
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");
    await expect(visibleTestId(page, "leaf-input")).toHaveValue("same-segment-state");

    await visibleTestId(page, "refresh").click();
    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");
  });

  test("mints bfcacheIds for programmatic push and replace", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const pushInitialBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "router-push-x-2").click();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    const pushedBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(pushedBfcacheId).toMatch(/^_b_\d+_$/);
    expect(pushedBfcacheId).not.toBe(pushInitialBfcacheId);

    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const replaceInitialBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "router-replace-x-2").click();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);
    const replacedBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(replacedBfcacheId).toMatch(/^_b_\d+_$/);
    expect(replacedBfcacheId).not.toBe(replaceInitialBfcacheId);
  });

  test("does not reuse restored bfcacheIds after a traverse redirect", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await visibleTestId(page, "layout-input").fill("stale-layout-state");
    const staleLayoutBfcacheId = await visibleTestId(page, "layout-bfcache-id").textContent();
    const staleHistoryState = await page.evaluate(() => structuredClone(window.history.state));

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);

    await page.evaluate(
      ({ currentHref, redirectHref, staleHistoryState }) => {
        window.history.pushState(staleHistoryState, "", redirectHref);
        window.history.pushState(window.history.state, "", currentHref);
      },
      {
        currentHref: `${ROUTE}/x/2`,
        redirectHref: "/nextjs-compat/use-router-bfcache-id-redirect-to-y",
        staleHistoryState,
      },
    );

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}${ROUTE}/y/1`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/y/1`);
    const redirectedLayoutBfcacheId = await visibleTestId(page, "layout-bfcache-id").textContent();
    expect(redirectedLayoutBfcacheId).toMatch(/^_b_\d+_$/);
    expect(redirectedLayoutBfcacheId).not.toBe(staleLayoutBfcacheId);
    await expect(visibleTestId(page, "layout-input")).toHaveValue("");
  });

  test("mints fresh bfcacheIds for intercepted slot target changes and restores ids on back", async ({
    page,
  }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.locator("#feed-photo-42-link").click();
    await expect(visibleTestId(page, "photo-modal")).toContainText("Viewing photo 42");
    const photo42BfcacheId = await visibleTestId(page, "photo-modal-bfcache-id").textContent();
    expect(photo42BfcacheId).toMatch(/^_b_\d+_$/);
    await visibleTestId(page, "photo-modal-input").fill("photo-42-state");

    await page.locator("#modal-photo-43-link").click();
    await expect(visibleTestId(page, "photo-modal")).toContainText("Viewing photo 43");
    const photo43BfcacheId = await visibleTestId(page, "photo-modal-bfcache-id").textContent();
    expect(photo43BfcacheId).toMatch(/^_b_\d+_$/);
    expect(photo43BfcacheId).not.toBe(photo42BfcacheId);
    await expect(visibleTestId(page, "photo-modal-input")).toHaveValue("");
    await visibleTestId(page, "photo-modal-input").fill("photo-43-state");

    await page.goBack();
    await expect(visibleTestId(page, "photo-modal")).toContainText("Viewing photo 42");
    await expect(visibleTestId(page, "photo-modal-bfcache-id")).toHaveText(photo42BfcacheId ?? "");
    await expect(visibleTestId(page, "photo-modal-input")).not.toHaveValue("photo-43-state");
  });

  test("preserves leaf form state across a server action refresh", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const initialBfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "leaf-input").fill("server-action-state");

    const actionResponse = waitForServerActionResponse(page, `${ROUTE}/x/1`);
    await visibleTestId(page, "server-action-refresh").click();
    await actionResponse;

    await expect(visibleTestId(page, "leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");
    await expect(visibleTestId(page, "leaf-input")).toHaveValue("server-action-state");
  });

  test("does not restore stale history bfcacheIds after a server action invalidates cache", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const staleX1BfcacheId = await visibleTestId(page, "leaf-bfcache-id").textContent();
    await visibleTestId(page, "leaf-input").fill("stale-x1-state");

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/2`);

    const actionResponse = waitForServerActionResponse(page, `${ROUTE}/x/2`);
    await visibleTestId(page, "server-action-refresh").click();
    await actionResponse;

    await page.goBack();
    await expect(visibleTestId(page, "pathname")).toHaveText(`${ROUTE}/x/1`);
    const restoredAfterInvalidation = await visibleTestId(page, "leaf-bfcache-id").textContent();
    expect(restoredAfterInvalidation).toMatch(/^_b_\d+_$/);
    expect(restoredAfterInvalidation).not.toBe(staleX1BfcacheId);
    await expect(visibleTestId(page, "leaf-input")).toHaveValue("");
  });
});
