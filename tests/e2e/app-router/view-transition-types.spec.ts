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

  test("server component importing addTransitionType gets the no-op fallback", async ({ page }) => {
    const res = await page.goto(`${BASE}/view-transition-server-types`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("vt-server-add-transition-type")).toHaveText("function");
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

  test("router.push with transitionTypes before the router state is ready keeps its types", async ({
    page,
  }) => {
    await recordViewTransitions(page);
    // Call router.push in a microtask right after the browser entry registers
    // its navigation functions. That runs after hydrateRoot() returns but
    // before React's scheduled hydration commit attaches the router state, so
    // the navigation waits for the router and publishes its pending state
    // after that await.
    await page.addInitScript(() => {
      const key = Symbol.for("vinext.navigationRuntime");
      let runtime: unknown;
      let pushed = false;
      Object.defineProperty(window, key, {
        configurable: true,
        get: () => runtime,
        set(value: Record<string, unknown>) {
          runtime = value;
          let functions: unknown = value.functions;
          Object.defineProperty(value, "functions", {
            configurable: true,
            enumerable: true,
            get: () => functions,
            set(next: { navigate?: unknown }) {
              functions = next;
              if (pushed || typeof next?.navigate !== "function") return;
              pushed = true;
              queueMicrotask(() => {
                (window as any).next.router.push("/view-transition-types/target", {
                  transitionTypes: ["early-push"],
                });
              });
            },
          });
        },
      });
    });
    await page.goto(`${BASE}/view-transition-types`);
    await expect(page.getByTestId("vt-target")).toBeVisible();
    await expect.poll(async () => (await readRecordedTypes(page)).length).toBeGreaterThan(0);
    const types = await readRecordedTypes(page);
    expect(types.every((entry) => entry?.includes("early-push"))).toBe(true);
  });

  test("a navigation that commits an optimistic loading shell first tags only that commit", async ({
    page,
  }) => {
    await openSource(page);

    // Settle a prefetch of a sibling URL so the route's loading-shell template
    // is learned. Dev links do not prefetch on viewport entry.
    const prefetchResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/view-transition-types/slow/1") && response.url().includes("_rsc"),
    );
    await page.evaluate(() => {
      (window as any).next.router.prefetch("/view-transition-types/slow/1");
    });
    await (await prefetchResponse).finished();
    // The template is learned once the prefetch cache entry settles.
    await page.waitForTimeout(500);

    // Hold the navigation's response so the shell commits before it lands.
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    await page.route("**/view-transition-types/slow/2?_rsc*", async (route) => {
      await navigationGate;
      await route.continue();
    });

    await page.getByTestId("typed-slow-link").click();
    await expect(page.getByTestId("vt-slow-loading")).toBeVisible();
    await expect.poll(async () => (await readRecordedTypes(page)).length).toBeGreaterThan(0);
    const shell = await readRecordedTypes(page);
    expect(shell.every((entry) => entry?.includes("nav-shell"))).toBe(true);

    releaseNavigation();
    await expect(page.getByTestId("vt-slow-2")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await readRecordedTypes(page)).length)
      .toBeGreaterThan(shell.length);
    // Like Next.js, the content filling in after the shell is not tagged again.
    const fill = (await readRecordedTypes(page)).slice(shell.length);
    expect(fill.every((entry) => entry === null)).toBe(true);
  });
});
