import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
// Middleware rewrites `${ROOT}/<path>` to `${ROOT}/ja/<path>` unless it starts
// with `/en/` or `/ja/`. A prefetch of `${ROOT}/en/datasets/x` correctly learns
// a template for `[locale]/datasets/[id]`. The unprefixed URL
// `${ROOT}/accounts/datasets/<id>` matches that template on the client
// (`locale = "accounts"`), but the server rewrites it to
// `${ROOT}/ja/accounts/datasets/<id>` and renders `[locale]/[...rest]`.
const ROOT = "/nextjs-compat/optimistic-rewrite";

async function navigateWatchingForDatasetShell(page: Page, href: string): Promise<boolean> {
  await page.evaluate(() => {
    Reflect.set(window, "__datasetShellSeen", false);
    const observer = new MutationObserver(() => {
      if (document.querySelector("#dataset-loading, #dataset-header") !== null) {
        Reflect.set(window, "__datasetShellSeen", true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Reflect.set(window, "__datasetShellObserver", observer);
  });

  // Hold the navigation's response so an optimistic shell would be visible.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  const pattern = `**${href}?_rsc*`;
  await page.route(pattern, async (route) => {
    requested = true;
    await gate;
    await route.continue();
  });

  await page.evaluate((target) => {
    const router = Reflect.get(window, "next") as { router: { push(href: string): void } };
    router.router.push(target);
  }, href);
  await expect.poll(() => requested).toBe(true);
  await page.waitForTimeout(500);
  release();

  await expect(page.locator("#rewrite-catch-all")).toBeVisible();
  await expect(page).toHaveURL(`${BASE}${href}`);
  await page.unroute(pattern);
  return page.evaluate(() => {
    (Reflect.get(window, "__datasetShellObserver") as MutationObserver).disconnect();
    return Reflect.get(window, "__datasetShellSeen") === true;
  });
}

// Next.js 16.2.7: dispatchRetryDueToTreeMismatch marks the route pattern with
// hasDynamicRewrite, and matchKnownRoute skips it afterwards. The wrong shell
// shows at most once per pattern.
test("stops predicting a template after a rewrite answers it with another route", async ({
  page,
}) => {
  await page.goto(`${BASE}${ROOT}/accounts/a`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#account-page")).toHaveText("Account a");

  // A loading-shell prefetch of an explicitly prefixed URL, which renders the
  // route it matches and so learns a correct `[locale]/datasets/[id]` template.
  await page.evaluate((href) => {
    const router = Reflect.get(window, "next") as { router: { prefetch(href: string): void } };
    router.router.prefetch(href);
  }, `${ROOT}/en/datasets/x`);
  await expect
    .poll(() =>
      page.evaluate((href) => {
        const cache = Reflect.get(window, "__VINEXT_RSC_PREFETCH_CACHE__") as
          | Map<string, { outcome?: string; pending?: Promise<void> }>
          | undefined;
        return Array.from(cache?.entries() ?? []).some(
          ([key, entry]) =>
            key.includes(href) && entry.outcome === "cache-seeded" && entry.pending === undefined,
        );
      }, `${ROOT}/en/datasets/x`),
    )
    .toBe(true);

  // First unprefixed navigation: the template predicts the dataset route, and
  // the server answers with the catch-all. Next.js also shows the wrong shell
  // this once; it confirms the setup reaches the optimistic path.
  const firstSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/accounts/datasets/y`);
  expect(firstSeen, "setup: first navigation shows the optimistic dataset shell").toBe(true);

  // Second navigation like it: the mismatch should have retired the template.
  const secondSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/accounts/datasets/z`);
  expect(secondSeen, "the wrong dataset shell shows again after a known mismatch").toBe(false);
});
