import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// A <Link> whose navigation hides it in a BFCache Activity must settle to idle
// before it is shown again. Next.js keeps useLinkStatus in useOptimistic state,
// which reverts when the navigation transition finishes whether or not the Link
// is visible. The (checkout) route group has no layout, so leaving (main) for it
// hides the (main) layout and its links, like the app-router-playground route
// groups demo.
const ROUTE = "/link-status";

function linkStatus(page: Page, id: string) {
  return page.locator(`#${id}-status:visible`).first();
}

async function openCheckout(page: Page) {
  await page.goto(ROUTE);
  await waitForAppRouterHydration(page);
  await expect(linkStatus(page, "checkout-link")).toHaveText("idle");

  await page.locator("#checkout-link:visible").click();
  await expect(page.locator("h2:visible")).toHaveText("Checkout");
  await expect(linkStatus(page, "back-link")).toHaveText("idle");
}

// Records every frame in which a visible link status reads "pending", so a
// revealed link that only settles after it is shown still fails.
async function recordVisiblePending(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __visiblePending: string[] }).__visiblePending = seen;
    const check = () => {
      for (const status of document.querySelectorAll<HTMLElement>("[id$='-status']")) {
        if (status.textContent === "pending" && status.checkVisibility()) seen.push(status.id);
      }
      requestAnimationFrame(check);
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    requestAnimationFrame(check);
  });
}

async function visiblePending(page: Page) {
  return page.evaluate(() => [
    ...new Set((window as unknown as { __visiblePending: string[] }).__visiblePending),
  ]);
}

test.describe("useLinkStatus in BFCache Activity entries", () => {
  test("a link hidden by its own navigation is idle when a link brings it back", async ({
    page,
  }) => {
    await openCheckout(page);
    await recordVisiblePending(page);

    // The Back link itself may show pending while its navigation is in flight;
    // only the revealed links must never come back pending.
    await page.locator("#back-link:visible").click();
    await expect(page.locator("h2:visible")).toHaveText("Link status home");
    await expect(linkStatus(page, "checkout-link")).toHaveText("idle");
    await expect(linkStatus(page, "home-link")).toHaveText("idle");
    expect((await visiblePending(page)).filter((id) => id !== "back-link-status")).toEqual([]);
  });

  test("a link hidden by its own navigation is idle after browser back and forward", async ({
    page,
  }) => {
    await openCheckout(page);
    await recordVisiblePending(page);

    await page.goBack();
    await expect(page.locator("h2:visible")).toHaveText("Link status home");
    await expect(linkStatus(page, "checkout-link")).toHaveText("idle");

    await page.goForward();
    await expect(page.locator("h2:visible")).toHaveText("Checkout");
    await expect(linkStatus(page, "back-link")).toHaveText("idle");
    expect(await visiblePending(page)).toEqual([]);
  });
});
