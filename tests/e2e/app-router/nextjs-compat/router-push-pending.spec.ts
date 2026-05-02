/**
 * Next.js Compat E2E: router push pending state
 *
 * Next.js references:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/use-link-status/index.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts#L482
 *   (redirect-with-loading: verifies redirect only triggers once and does not flicker)
 *
 * The contract we care about here is that a programmatic App Router navigation
 * started inside useTransition should flip isPending immediately and keep it
 * true until the navigation commits.
 */

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: router.push pending state (browser)", () => {
  test("same-route search param push keeps useTransition pending until commit", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/router-push-pending`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#pending-state")).toHaveText("idle");
    await expect(page.locator("#client-filter")).toHaveText("client filter: none");
    await expect(page.locator("#server-filter")).toHaveText("server filter: none");

    const clickPromise = page.click("#push-alpha", { noWaitAfter: true });

    await expect(page.locator("#pending-state")).toHaveText("pending", {
      timeout: 1_000,
    });
    await clickPromise;
    await expect(page.locator("#client-filter")).toHaveText("client filter: alpha", {
      timeout: 10_000,
    });
    await expect(page.locator("#server-filter")).toHaveText("server filter: alpha", {
      timeout: 10_000,
    });
    await expect(page.locator("#pending-state")).toHaveText("idle", {
      timeout: 10_000,
    });
  });

  /**
   * Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
   * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts#L482
   *
   * When router.push() targets a page whose server component calls redirect(),
   * isPending must stay true continuously from the push until the final
   * destination commits. Previously, a bandage settle fired before the
   * recursive navigate() call, causing isPending to flash false mid-redirect.
   *
   * Detection strategy: install a MutationObserver before click, record every
   * text value #pending-state takes. After the destination commits, assert
   * that no "idle" value appeared before the final "idle" (i.e. no mid-redirect
   * flash). Because the destination page does not render #pending-state, we
   * track when the element is removed as the end-of-navigation signal.
   */
  test("push to server-redirecting page keeps useTransition pending through redirect", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/router-push-pending`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#pending-state")).toHaveText("idle");

    // Install a MutationObserver to record every text value of #pending-state
    // before clicking. This captures the state transitions during the redirect.
    await page.evaluate(() => {
      const log: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__pendingLog = log;

      const el = document.querySelector("#pending-state");
      if (!el) return;

      // Record initial value
      log.push(el.textContent ?? "");

      const obs = new MutationObserver(() => {
        // el may have been detached; try to re-query
        const current = document.querySelector("#pending-state");
        if (current) {
          log.push(current.textContent ?? "");
        } else {
          // Element removed from DOM — navigation committed to destination page
          log.push("__removed__");
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__pendingObs = obs;
    });

    await page.click("#push-redirect");

    // Wait for destination page to appear — the redirect committed
    await expect(page.locator("#redirect-destination")).toBeVisible({
      timeout: 10_000,
    });

    // Collect the log. The observer may still be running; disconnect it.
    const log = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      (w.__pendingObs as MutationObserver | undefined)?.disconnect();
      return w.__pendingLog as string[];
    });

    // The sequence must be: "idle" (before click) then one or more "pending"
    // entries, then possibly "__removed__" once the destination renders.
    // Any "idle" between the first "pending" and the final removal is the bug.
    const firstPendingIdx = log.indexOf("pending");
    expect(
      firstPendingIdx,
      `isPending never became "pending". Log: ${JSON.stringify(log)}`,
    ).toBeGreaterThan(-1);

    // Slice from first "pending" to the last observed value before removal.
    const afterFirstPending = log.slice(firstPendingIdx);
    const removedIdx = afterFirstPending.indexOf("__removed__");
    const beforeRemoval =
      removedIdx >= 0 ? afterFirstPending.slice(0, removedIdx) : afterFirstPending;

    const idleFlash = beforeRemoval.indexOf("idle");
    expect(
      idleFlash,
      `isPending flashed "idle" mid-redirect at index ${idleFlash}. Full log: ${JSON.stringify(log)}`,
    ).toBe(-1);

    // Final state: URL is at destination
    expect(page.url()).toContain("/nextjs-compat/router-push-pending-destination");
  });
});
