import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

type RecordedTypes = (string[] | null)[];

// Record the `types` React passes to document.startViewTransition on each
// view-transition commit (`null` when the transition has no types).
async function recordViewTransitions(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __vtTypes: (string[] | null)[] };
    w.__vtTypes = [];
    const original = document.startViewTransition?.bind(document);
    if (!original) return;
    (document as any).startViewTransition = (arg: any) => {
      w.__vtTypes.push(
        arg && typeof arg === "object" && arg.types ? Array.from(arg.types as string[]) : null,
      );
      return original(arg);
    };
  });
}

function readRecordedTypes(page: Page): Promise<RecordedTypes> {
  return page.evaluate(() => (window as any).__vtTypes);
}

async function openSource(page: Page) {
  await recordViewTransitions(page);
  await page.goto(`${BASE}/view-transition-types`);
  await expect(page.getByTestId("vt-source")).toBeVisible();
  await waitForAppRouterHydration(page);
}

// Navigate with the given control and return the view transitions it started.
async function navigateAndRecord(page: Page, testId: string): Promise<RecordedTypes> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("vt-target")).toBeVisible();
  await expect.poll(async () => (await readRecordedTypes(page)).length).toBeGreaterThan(0);
  return readRecordedTypes(page);
}

test.describe("App Router view transition types", () => {
  test("server component importing Suspense beside ViewTransition renders in dev", async ({
    page,
  }) => {
    const res = await page.goto(`${BASE}/view-transition-suspense`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("vt-suspense-content")).toHaveText(
      "suspense beside view transition",
    );
  });

  test("<Link transitionTypes> passes its types to the view transition", async ({ page }) => {
    await openSource(page);
    const types = await navigateAndRecord(page, "typed-link");
    expect(types.every((entry) => entry?.includes("nav-forward"))).toBe(true);
  });

  test("router.push(href, { transitionTypes }) passes its types to the view transition", async ({
    page,
  }) => {
    await openSource(page);
    const types = await navigateAndRecord(page, "typed-push");
    expect(types.every((entry) => entry?.includes("nav-push"))).toBe(true);
  });

  test("router.replace(href, { transitionTypes }) passes its types to the view transition", async ({
    page,
  }) => {
    await openSource(page);
    const types = await navigateAndRecord(page, "typed-replace");
    expect(types.every((entry) => entry?.includes("nav-replace"))).toBe(true);
  });

  test("a Link without transitionTypes starts an untyped view transition", async ({ page }) => {
    await openSource(page);
    const types = await navigateAndRecord(page, "untyped-link");
    expect(types.every((entry) => entry === null)).toBe(true);
  });
});
