import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174";
const BEFORE_MARKER = ">before edit<";
const AFTER_MARKER = ">after edit<";

type HmrRecord = {
  fallbackShown: boolean;
  minScrollHeight: number;
  minScrollY: number;
};

test("a server-component HMR update keeps revealed content and the scroll position", async ({
  page,
}) => {
  const pagePath = path.resolve(
    process.cwd(),
    "tests/fixtures/app-basic/app/hmr-suspense-scroll/page.tsx",
  );
  // Restore a known state, so an interrupted earlier run cannot leave the
  // edited marker behind as this run's baseline.
  const current = await fs.readFile(pagePath, "utf8");
  const original = current.replace(AFTER_MARKER, BEFORE_MARKER);
  if (original !== current) await fs.writeFile(pagePath, original);

  try {
    await page.goto(`${BASE}/hmr-suspense-scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("hmr-suspense-scroll-marker")).toHaveText("before edit");

    await page.evaluate(() => window.scrollTo(0, 4000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(4000);

    // Record whether the layout's Suspense fallback ever replaces the page, and
    // the lowest document height and scroll position seen during the update.
    await page.evaluate(() => {
      const record: HmrRecord = {
        fallbackShown: false,
        minScrollHeight: document.documentElement.scrollHeight,
        minScrollY: window.scrollY,
      };
      (window as Window & { __hmrRecord?: HmrRecord }).__hmrRecord = record;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="hmr-suspense-scroll-fallback"]')) {
          record.fallbackShown = true;
        }
        record.minScrollHeight = Math.min(
          record.minScrollHeight,
          document.documentElement.scrollHeight,
        );
      }).observe(document.body, { childList: true, subtree: true });
      window.addEventListener(
        "scroll",
        () => {
          record.minScrollY = Math.min(record.minScrollY, window.scrollY);
        },
        { passive: true },
      );
    });

    await fs.writeFile(pagePath, original.replace(BEFORE_MARKER, AFTER_MARKER));

    await expect(page.getByTestId("hmr-suspense-scroll-marker")).toHaveText("after edit");
    const record = await page.evaluate(
      () => (window as Window & { __hmrRecord?: HmrRecord }).__hmrRecord,
    );
    expect(record).toBeDefined();
    expect(record!.fallbackShown).toBe(false);
    expect(record!.minScrollHeight).toBeGreaterThan(10_000);
    expect(record!.minScrollY).toBe(4000);
    expect(await page.evaluate(() => window.scrollY)).toBe(4000);
  } finally {
    await fs.writeFile(pagePath, original);
  }
});
