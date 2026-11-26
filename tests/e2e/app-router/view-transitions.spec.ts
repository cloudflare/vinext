import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js tags a navigation's Transition with `<Link transitionTypes>` /
// `router.push(href, { transitionTypes })`, so a <ViewTransition> can pick its
// enter/exit class by type: https://nextjs.org/docs/app/guides/view-transitions
// Ported from Next.js: packages/next/src/client/components/app-router-instance.ts

type RecordedTransition = { types: string[]; classes: string[]; done: boolean };

// Record each document.startViewTransition call: its types, and the
// view-transition-class values React set on the old and the new DOM.
async function recordViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: RecordedTransition[] = [];
    Reflect.set(window, "__viewTransitions", recorded);
    // oxlint-disable-next-line typescript/unbound-method -- re-bound with .call below
    const start = Document.prototype.startViewTransition;
    const collectClasses = (into: string[]) => {
      for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
        const value = el.style.getPropertyValue("view-transition-class");
        if (value && value !== "none") into.push(value);
      }
    };
    Document.prototype.startViewTransition = function (
      this: Document,
      arg?: ViewTransitionUpdateCallback | StartViewTransitionOptions,
    ) {
      const types = typeof arg === "object" && arg.types ? Array.from(arg.types) : [];
      const record: RecordedTransition = { types, classes: [], done: false };
      recorded.push(record);
      collectClasses(record.classes);
      const transition = start.call(this, arg as StartViewTransitionOptions);
      const finish = () => {
        collectClasses(record.classes);
        record.done = true;
      };
      transition.updateCallbackDone.then(finish, finish);
      return transition;
    } as typeof Document.prototype.startViewTransition;
  });
}

async function viewTransitions(page: Page, count: number): Promise<RecordedTransition[]> {
  const read = () =>
    page.evaluate(() => Reflect.get(window, "__viewTransitions") as RecordedTransition[]);
  await expect
    .poll(async () => (await read()).filter((transition) => transition.done).length)
    .toBe(count);
  return read();
}

test.beforeEach(async ({ page }) => {
  await recordViewTransitions(page);
  await page.goto("/view-transitions/a");
  await waitForAppRouterHydration(page);
});

test("<Link transitionTypes> selects the typed enter and exit animations", async ({ page }) => {
  await page.getByTestId("vt-link-b-typed").click();
  await expect(page.getByTestId("vt-page-b")).toBeVisible();

  const [navigation] = await viewTransitions(page, 1);
  expect(navigation.types).toEqual(["nav-forward"]);
  expect(navigation.classes).toEqual(expect.arrayContaining(["slide-out", "slide-in"]));
  expect(navigation.classes).not.toContain("page-enter");
});

test("router.push(href, { transitionTypes }) selects the typed animations", async ({ page }) => {
  await page.getByTestId("vt-push-b-typed").click();
  await expect(page.getByTestId("vt-page-b")).toBeVisible();

  const [navigation] = await viewTransitions(page, 1);
  expect(navigation.types).toEqual(["nav-back"]);
  expect(navigation.classes).toEqual(expect.arrayContaining(["slide-back-out", "slide-back-in"]));
});

// The reveal page imports Suspense beside ViewTransition from "react", which
// the dev polyfill rewrite used to turn into an undefined Suspense.
test("a page importing Suspense and ViewTransition animates its Suspense reveal", async ({
  page,
}) => {
  await page.getByTestId("vt-link-reveal").click();
  await expect(page.getByTestId("vt-reveal-content")).toBeVisible();

  const [, reveal] = await viewTransitions(page, 2);
  expect(reveal.classes).toEqual(expect.arrayContaining(["skeleton-exit", "content-enter"]));
});
