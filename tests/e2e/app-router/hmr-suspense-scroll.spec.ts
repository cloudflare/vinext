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

const pagePath = path.resolve(
  process.cwd(),
  "tests/fixtures/app-basic/app/hmr-suspense-scroll/page.tsx",
);

// Restore a known state, so an interrupted earlier run cannot leave the edited
// marker behind as this run's baseline.
async function readOriginalPage(): Promise<string> {
  const current = await fs.readFile(pagePath, "utf8");
  const original = current.replace(AFTER_MARKER, BEFORE_MARKER);
  if (original !== current) await fs.writeFile(pagePath, original);
  return original;
}

// Wait until the dev server serves the restored page, so the next test does not
// load the edited module.
async function restorePage(original: string): Promise<void> {
  await fs.writeFile(pagePath, original);
  await expect
    .poll(async () => (await fetch(`${BASE}/hmr-suspense-scroll`)).text(), { timeout: 15_000 })
    .toContain("before edit");
}

test("a server-component HMR update keeps revealed content and the scroll position", async ({
  page,
}) => {
  const original = await readOriginalPage();

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
    await restorePage(original);
  }
});

test("a link navigation during a suspended HMR update still commits", async ({ page }) => {
  const original = await readOriginalPage();

  try {
    await page.goto(`${BASE}/hmr-suspense-scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("hmr-suspense-scroll-marker")).toHaveText("before edit");

    // The page renders a second after the HMR response starts streaming, so
    // the update is still suspended when the link is clicked.
    const hmrResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/hmr-suspense-scroll" &&
        response.request().headers()["rsc"] === "1",
    );
    await fs.writeFile(pagePath, original.replace(BEFORE_MARKER, AFTER_MARKER));
    await hmrResponse;
    await page.getByTestId("hmr-suspense-scroll-link").click();

    await expect(page.getByTestId("hmr-suspense-scroll-target")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}/hmr-suspense-scroll/target`);
  } finally {
    await restorePage(original);
  }
});
