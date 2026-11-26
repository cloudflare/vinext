import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// React's <ViewTransition> animates App Router navigations because each one is
// a Transition. Next.js tags that Transition with `<Link transitionTypes>` /
// `router.push(href, { transitionTypes })`, so a <ViewTransition> can pick its
// enter/exit class by type:
// https://nextjs.org/docs/app/guides/view-transitions
// Ported from Next.js: packages/next/src/client/components/app-router-instance.ts
// (`navigate` calls `addTransitionType` inside its `startTransition`).

type RecordedTransition = { types: string[]; classes: string[] };

async function recordViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: Array<{ types: string[]; classes: string[] }> = [];
    Reflect.set(window, "__vtCalls", calls);
    if (typeof Document.prototype.startViewTransition !== "function") return;
    // oxlint-disable-next-line typescript/unbound-method -- re-bound with .call below
    const start = Document.prototype.startViewTransition;
    const collect = (into: string[]) => {
      for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
        const value = el.style.getPropertyValue("view-transition-class");
        if (value && value !== "none" && !into.includes(value)) into.push(value);
      }
    };
    Document.prototype.startViewTransition = function (
      this: Document,
      arg?: ViewTransitionUpdateCallback | StartViewTransitionOptions,
    ) {
      const types =
        arg && typeof arg === "object" && arg.types ? Array.from(arg.types) : ([] as string[]);
      const record = { types, classes: [] as string[] };
      calls.push(record);
      collect(record.classes);
      const transition = start.call(this, arg as StartViewTransitionOptions);
      void transition.updateCallbackDone.then(
        () => collect(record.classes),
        () => {},
      );
      return transition;
    } as typeof Document.prototype.startViewTransition;
  });
}

async function transitions(page: Page): Promise<RecordedTransition[]> {
  return page.evaluate(() => Reflect.get(window, "__vtCalls") as RecordedTransition[]);
}

async function settledTransitions(page: Page, count: number): Promise<RecordedTransition[]> {
  await expect.poll(async () => (await transitions(page)).length).toBe(count);
  await page.waitForFunction(() => !document.getAnimations().length);
  return transitions(page);
}

test.beforeEach(async ({ page }) => {
  await recordViewTransitions(page);
  await page.goto("/view-transitions/a");
  await waitForAppRouterHydration(page);
});

test("a Link navigation runs the page's enter and exit view transitions", async ({ page }) => {
  await page.getByTestId("vt-link-b").click();
  await expect(page.getByTestId("vt-page-b")).toBeVisible();
  const [navigation] = await settledTransitions(page, 1);
  expect(navigation.types).toEqual([]);
  expect(navigation.classes).toEqual(expect.arrayContaining(["page-exit", "page-enter"]));
});

test("<Link transitionTypes> tags the navigation's view transition", async ({ page }) => {
  await page.getByTestId("vt-link-b-typed").click();
  await expect(page.getByTestId("vt-page-b")).toBeVisible();
  const [navigation] = await settledTransitions(page, 1);
  expect(navigation.types).toEqual(["nav-forward"]);
  expect(navigation.classes).toEqual(expect.arrayContaining(["slide-out", "slide-in"]));
  expect(navigation.classes).not.toContain("page-enter");
});

test("router.push(href, { transitionTypes }) tags the navigation's view transition", async ({
  page,
}) => {
  await page.getByTestId("vt-link-b").click();
  await expect(page.getByTestId("vt-page-b")).toBeVisible();
  await settledTransitions(page, 1);

  await page.getByTestId("vt-push-a-typed").click();
  await expect(page.getByTestId("vt-page-a")).toBeVisible();
  const [, navigation] = await settledTransitions(page, 2);
  expect(navigation.types).toEqual(["nav-back"]);
  expect(navigation.classes).toEqual(expect.arrayContaining(["slide-back-out", "slide-back-in"]));
});

test("a Suspense reveal after a navigation runs its own view transition", async ({ page }) => {
  await page.getByTestId("vt-link-reveal").click();
  await expect(page.getByTestId("vt-reveal-content")).toBeVisible();
  const recorded = await settledTransitions(page, 2);
  expect(recorded[0].classes).toContain("page-exit");
  expect(recorded[1].classes).toEqual(expect.arrayContaining(["skeleton-exit", "content-enter"]));
});
