import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174/nextjs-compat/parallel-routes-scroll-owner/modal";

async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

// Ported from Next.js:
// test/e2e/app-dir/parallel-routes-scroll-owner/parallel-routes-scroll-owner.test.ts
// A parallel slot that changes owns the navigation's scroll signal. A slot that
// renders nothing cannot handle it, and the retained children slot must not
// pick it up instead.
test.describe("Next.js compat: parallel routes scroll owner", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);
  });

  test("preserves scroll when an empty intercepted modal is the only changed slot", async ({
    page,
  }) => {
    await page.evaluate(() => window.scrollTo(0, 1200));
    const initialScroll = await page.evaluate(() => window.scrollY);
    expect(initialScroll).toBeGreaterThan(0);

    await page.locator("#open-empty-modal").click();
    await expect(page).toHaveURL(`${BASE}/open`);
    await settleFrames(page);

    expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
  });

  test("does not blur focus when the empty slot cannot handle scroll", async ({ page }) => {
    await page.evaluate(() => {
      window.scrollTo(0, 1200);
      document.getElementById("focus-target")?.focus({ preventScroll: true });
      document.getElementById("open-empty-modal")?.click();
    });
    await expect(page).toHaveURL(`${BASE}/open`);
    await settleFrames(page);

    expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus-target");
  });

  test("consumes a missing hash without scrolling or blurring", async ({ page }) => {
    const initialScroll = await page.evaluate(() => {
      window.scrollTo(0, 1200);
      document.getElementById("focus-target")?.focus({ preventScroll: true });
      document.getElementById("open-modal-missing-hash")?.click();
      return window.scrollY;
    });
    await expect(page).toHaveURL(`${BASE}/visible#missing-target`);
    await expect(page.locator("#visible-modal")).toHaveText("Visible modal");
    await settleFrames(page);

    expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus-target");
  });

  test("scrolls to a real hash target", async ({ page }) => {
    await page.locator("#open-empty-modal-real-hash").click();
    await expect(page).toHaveURL(`${BASE}/open#hash-target`);

    await expect
      .poll(async () =>
        Math.abs(
          await page.evaluate(
            () => document.getElementById("hash-target")?.getBoundingClientRect().top ?? 9999,
          ),
        ),
      )
      .toBeLessThan(1);
  });
});
