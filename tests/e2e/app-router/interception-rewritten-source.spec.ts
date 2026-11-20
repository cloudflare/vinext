// /gated-members/[id] intercepts /photos/[id] in its @modal slot, and an
// afterFiles rewrite serves /gated-login in its place to clients without the
// `gated-pass` cookie. Next.js derives the interception context from the tree
// the client rendered, so a client shown the login page navigates to the photo
// page itself, softly, while a member sees the modal over the member page.

import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

async function setSoftNavigationMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __gatedSoftNavMarker?: boolean }).__gatedSoftNavMarker = true;
  });
}

async function readSoftNavigationMarker(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as Window & { __gatedSoftNavMarker?: boolean }).__gatedSoftNavMarker === true,
  );
}

test.describe("interception from a rewritten source", () => {
  test("navigates softly to the target page from a source rewritten to a page without the intercept", async ({
    page,
  }) => {
    await page.goto(`${BASE}/gated-members/7`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("gated-login-page")).toBeVisible();
    await expect(page.getByTestId("gated-member-page")).toHaveCount(0);
    await setSoftNavigationMarker(page);

    await page.click("#gated-login-photo-link");

    await expect(page).toHaveURL(`${BASE}/photos/1`);
    await expect(page.getByTestId("photo-page")).toBeVisible();
    await expect(page.getByTestId("gated-members-photo-modal")).toHaveCount(0);
    await expect(page.getByTestId("gated-members-layout")).toHaveCount(0);
    expect(await readSoftNavigationMarker(page)).toBe(true);
  });

  test("intercepts the target over the member page for a client with the pass cookie", async ({
    page,
  }) => {
    await page.context().addCookies([{ name: "gated-pass", value: "1", url: BASE }]);
    await page.goto(`${BASE}/gated-members/7`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("gated-member-page")).toBeVisible();
    await setSoftNavigationMarker(page);

    await page.click("#gated-member-photo-link");

    await expect(page).toHaveURL(`${BASE}/photos/1`);
    await expect(page.getByTestId("gated-members-photo-modal")).toBeVisible();
    await expect(page.getByTestId("gated-member-page")).toBeVisible();
    await expect(page.getByTestId("photo-page")).toHaveCount(0);
    expect(await readSoftNavigationMarker(page)).toBe(true);
  });

  test("intercepts the target over the member page that afterFiles routes back to after beforeFiles rewrite it away", async ({
    page,
  }) => {
    // The login rule comes before the rule that routes the detour back, so it
    // never applies and no pass cookie is needed.
    await page.context().addCookies([{ name: "gated-detour", value: "1", url: BASE }]);
    await page.goto(`${BASE}/gated-members/7`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("gated-member-page")).toBeVisible();
    await setSoftNavigationMarker(page);

    await page.click("#gated-member-photo-link");

    await expect(page).toHaveURL(`${BASE}/photos/1`);
    await expect(page.getByTestId("gated-members-photo-modal")).toBeVisible();
    await expect(page.getByTestId("gated-member-page")).toBeVisible();
    await expect(page.getByTestId("photo-page")).toHaveCount(0);
    expect(await readSoftNavigationMarker(page)).toBe(true);
  });
});
