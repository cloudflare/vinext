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

async function clearVisiblePending(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __visiblePending: string[] }).__visiblePending.length = 0;
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

  // A sibling intercept keeps its source page in a BFCache entry, and the
  // intercept itself is kept when its source is shown again.
  test("links in a sibling intercept and its source are idle when revealed", async ({ page }) => {
    await page.goto("/bfcache-effects/gallery");
    await waitForAppRouterHydration(page);
    await recordVisiblePending(page);

    for (const [link, heading, revealed] of [
      ["gallery-open-photo", "Photo modal 1", "photo-1-back"],
      ["photo-1-back", "Gallery", "gallery-open-photo"],
      ["gallery-open-photo", "Photo modal 1", "photo-1-back"],
    ]) {
      await clearVisiblePending(page);
      await page.locator(`#${link}:visible`).click();
      await expect(page.locator("h2:visible")).toHaveText(heading);
      await expect(linkStatus(page, revealed)).toHaveText("idle");
      // Only the clicked link may show pending, while its navigation is in
      // flight.
      expect((await visiblePending(page)).filter((id) => id !== `${link}-status`)).toEqual([]);
    }
  });

  test("links in a dynamic sibling intercept are idle after browser back and forward", async ({
    page,
  }) => {
    await page.goto("/bfcache-effects/shots");
    await waitForAppRouterHydration(page);
    await page.locator("#shots-open-shot:visible").click();
    await expect(page.locator("h2:visible")).toHaveText("Shot modal 1");
    await recordVisiblePending(page);

    await page.goBack();
    await expect(page.locator("h2:visible")).toHaveText("Shots");
    await expect(linkStatus(page, "shots-open-shot")).toHaveText("idle");
    await page.goForward();
    await expect(page.locator("h2:visible")).toHaveText("Shot modal 1");
    await expect(linkStatus(page, "shot-1-back")).toHaveText("idle");
    expect(await visiblePending(page)).toEqual([]);
  });

  // Shot 2, opened from shot 1, renders under the shots route like shot 1, so
  // shot 1 is hidden rather than unmounted, with the link that left it.
  test("links in a sibling intercept opened from another are idle when revealed", async ({
    page,
  }) => {
    await page.goto("/bfcache-effects/shots");
    await waitForAppRouterHydration(page);
    await recordVisiblePending(page);

    const steps: [() => Promise<unknown>, string, string[], string | null][] = [
      [
        () => page.locator("#shots-open-shot:visible").click(),
        "Shot modal 1",
        ["shot-1-next"],
        "shots-open-shot",
      ],
      [
        () => page.locator("#shot-1-next:visible").click(),
        "Shot modal 2",
        ["shot-2-next"],
        "shot-1-next",
      ],
      [() => page.goBack(), "Shot modal 1", ["shot-1-back", "shot-1-next"], null],
      [() => page.goBack(), "Shots", ["shots-open-shot"], null],
      [() => page.goForward(), "Shot modal 1", ["shot-1-next"], null],
      [() => page.goForward(), "Shot modal 2", ["shot-2-next"], null],
      [
        () => page.locator("#shot-2-next:visible").click(),
        "Shot modal 3",
        ["shot-3-next"],
        "shot-2-next",
      ],
      // Three shots evict the shots page, and shot 1 comes back from its entry.
      [
        () => page.locator("#shot-3-next:visible").click(),
        "Shot modal 1",
        ["shot-1-back", "shot-1-next"],
        "shot-3-next",
      ],
    ];
    for (const [navigate, heading, revealed, clicked] of steps) {
      await clearVisiblePending(page);
      await navigate();
      await expect(page.locator("h2:visible")).toHaveText(heading);
      for (const link of revealed) await expect(linkStatus(page, link)).toHaveText("idle");
      expect((await visiblePending(page)).filter((id) => id !== `${clicked}-status`)).toEqual([]);
    }
  });

  // An optimistic shell for /rooms/d, learned from another room's prefetch,
  // hides room b with the link that left room a still in its tree.
  test("links in an entry an optimistic shell hides are idle when revealed", async ({ page }) => {
    await page.goto("/bfcache-effects/rooms/a");
    await waitForAppRouterHydration(page);
    await page.waitForLoadState("networkidle");
    await recordVisiblePending(page);

    const steps: [() => Promise<unknown>, string, string, string | null][] = [
      [
        () => page.locator("#room-a-switch:visible").click(),
        "Room b",
        "room-b-switch",
        "room-a-switch",
      ],
      [() => page.goBack(), "Room a", "room-a-switch", null],
      [() => page.goForward(), "Room b", "room-b-switch", null],
      [
        () =>
          page.evaluate(() => {
            (
              window as unknown as { next: { router: { push(href: string): void } } }
            ).next.router.push("/bfcache-effects/rooms/d");
          }),
        "Room d",
        "room-d-switch",
        null,
      ],
      [() => page.goBack(), "Room b", "room-b-switch", null],
      [() => page.goBack(), "Room a", "room-a-switch", null],
    ];
    for (const [navigate, heading, revealed, clicked] of steps) {
      await clearVisiblePending(page);
      await navigate();
      await expect(page.locator("h2:visible")).toHaveText(heading);
      await expect(linkStatus(page, revealed)).toHaveText("idle");
      expect((await visiblePending(page)).filter((id) => id !== `${clicked}-status`)).toEqual([]);
    }
  });
});
