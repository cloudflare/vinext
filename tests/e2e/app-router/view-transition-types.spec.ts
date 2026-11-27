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

// Settle a prefetch of a sibling URL so the slow route's loading-shell template
// is learned. Dev links do not prefetch on viewport entry.
async function learnSlowShellTemplate(page: Page) {
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
}

// Hold the slow navigation's RSC response so its loading shell commits first.
// Returns the function that releases it.
async function holdSlowNavigation(page: Page): Promise<() => void> {
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route("**/view-transition-types/slow/2?_rsc*", async (route) => {
    await navigationGate;
    await route.continue();
  });
  return releaseNavigation;
}

// Delay, by 1.5 s, the update callback of the first view transition whose
// types include `type`. Until then React has claimed that commit's types and
// started the transition, but has not run its mutation or layout effects. When
// `onHold` names a function exposed to the page, the page calls it as the hold
// starts. The delay stays under the browser's update-callback timeout.
async function holdFirstTypedViewTransition(
  page: Page,
  options: { type: string; onHold?: string },
) {
  await page.addInitScript(({ type, onHold }) => {
    const w = window as any;
    const startViewTransition = document.startViewTransition?.bind(document);
    if (!startViewTransition) return;
    let held = false;
    (document as any).startViewTransition = (arg: any) => {
      const types: unknown = arg && typeof arg === "object" ? arg.types : null;
      if (held || !Array.isArray(types) || !types.includes(type)) {
        return startViewTransition(arg);
      }
      held = true;
      if (onHold) void w[onHold]();
      const resumed = new Promise<void>((resolve) => setTimeout(resolve, 1500));
      return startViewTransition({ ...arg, update: () => resumed.then(() => arg.update()) });
    };
  }, options);
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
    await learnSlowShellTemplate(page);
    const releaseNavigation = await holdSlowNavigation(page);

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

  test("a payload dispatched while the loading shell's view transition starts commits untyped", async ({
    page,
  }) => {
    // Delay the update callback of the shell's view transition, the first one
    // typed `nav-shell`. React has claimed the shell's types and started the
    // transition, but has not run its mutation or layout effects yet. Release
    // the held response then, so the authoritative payload is dispatched in
    // that window.
    let releaseNavigation!: () => void;
    await page.exposeFunction("__vtReleaseNavigation", () => releaseNavigation());
    await recordViewTransitions(page);
    await holdFirstTypedViewTransition(page, {
      type: "nav-shell",
      onHold: "__vtReleaseNavigation",
    });
    await page.goto(`${BASE}/view-transition-types`);
    await expect(page.getByTestId("vt-source")).toBeVisible();
    await waitForAppRouterHydration(page);
    await learnSlowShellTemplate(page);
    releaseNavigation = await holdSlowNavigation(page);

    await page.getByTestId("typed-slow-link").click();

    await expect(page.getByTestId("vt-slow-2")).toBeVisible({ timeout: 10_000 });
    const all = await readRecordedTypes(page);
    const shellIndex = all.findIndex((entry) => entry?.includes("nav-shell"));
    expect(shellIndex).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await readRecordedTypes(page)).length)
      .toBeGreaterThan(shellIndex + 1);
    const fill = (await readRecordedTypes(page)).slice(shellIndex + 1);
    expect(fill.every((entry) => entry === null)).toBe(true);
  });

  test("a same-path search push whose response ends during its view transition is tagged once", async ({
    page,
  }) => {
    // The response streams its Suspense content after the first commit. Hold
    // that commit's view transition so the response ends while React has
    // claimed its types but not yet run its layout effects: the end-of-response
    // recovery publish runs in that window. Types it hands to React again are
    // queued while a Transition is pending, and tag that Transition's commit.
    await recordViewTransitions(page);
    // As the hold starts, the app starts a Transition of its own. React renders
    // it once the held commit finishes, so it is still pending when the
    // response ends.
    await page.addInitScript(() => {
      (window as any).__vtStartAppTransition = () => {
        setTimeout(() => {
          (window as any).__vtAppTransition();
        });
      };
    });
    await holdFirstTypedViewTransition(page, {
      type: "nav-search",
      onHold: "__vtStartAppTransition",
    });
    await page.goto(`${BASE}/view-transition-types/search?q=0`);
    await expect(page.getByTestId("vt-search-result")).toHaveText("result 0");
    await waitForAppRouterHydration(page);

    await page.getByTestId("typed-search-push").click();
    await expect(page.getByTestId("vt-search-result")).toHaveText("result 1", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("app-transition")).toHaveText("app transitions: 1");
    // Types that were queued again would tag this later, untyped navigation.
    await page.getByTestId("untyped-target-link").click();
    await expect(page.getByTestId("vt-target")).toBeVisible();

    const all = await readRecordedTypes(page);
    const firstIndex = all.findIndex((entry) => entry?.includes("nav-search"));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(all.length).toBeGreaterThan(firstIndex + 1);
    expect(all.slice(firstIndex + 1).every((entry) => entry === null)).toBe(true);
  });
});
