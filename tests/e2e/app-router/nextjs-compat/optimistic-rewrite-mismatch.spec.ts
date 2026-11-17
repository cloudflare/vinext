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

async function navigateWatchingForDatasetShell(
  page: Page,
  href: string,
  landing: { selector: string; href: string } = { selector: "#rewrite-catch-all", href },
): Promise<boolean> {
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

  await expect(page.locator(landing.selector)).toBeVisible();
  await expect(page).toHaveURL(`${BASE}${landing.href}`);
  await page.unroute(pattern);
  return page.evaluate(() => {
    (Reflect.get(window, "__datasetShellObserver") as MutationObserver).disconnect();
    return Reflect.get(window, "__datasetShellSeen") === true;
  });
}

// A loading-shell prefetch of an explicitly prefixed URL, which renders the
// route it matches and so learns a correct `[locale]/datasets/[id]` template.
async function learnDatasetTemplate(page: Page): Promise<void> {
  await page.goto(`${BASE}${ROOT}/accounts/a`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#account-page")).toHaveText("Account a");

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
}

// Next.js 16.2.7: dispatchRetryDueToTreeMismatch marks the route pattern with
// hasDynamicRewrite, and matchKnownRoute skips it afterwards. The wrong shell
// shows at most once per pattern.
test("stops predicting a template after a rewrite answers it with another route", async ({
  page,
}) => {
  await learnDatasetTemplate(page);

  // First unprefixed navigation: the template predicts the dataset route, and
  // the server answers with the catch-all. Next.js also shows the wrong shell
  // this once; it confirms the setup reaches the optimistic path.
  const firstSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/accounts/datasets/y`);
  expect(firstSeen, "setup: first navigation shows the optimistic dataset shell").toBe(true);

  // Second navigation like it: the mismatch should have retired the template.
  const secondSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/accounts/datasets/z`);
  expect(secondSeen, "the wrong dataset shell shows again after a known mismatch").toBe(false);
});

// Next.js canary marks the pattern with hasDynamicRewrite when the request is
// redirected (RedirectRetry in render-tree.ts); 16.2.7 does when the redirected
// tree mismatches. Middleware redirects `${ROOT}/en/datasets/moved-<id>` to
// `${ROOT}/en/accounts/<id>`.
test("stops predicting a template after the server redirects a URL it predicted", async ({
  page,
}) => {
  await learnDatasetTemplate(page);

  const firstSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/en/datasets/moved-y`, {
    selector: "#account-page",
    href: `${ROOT}/en/accounts/y`,
  });
  expect(firstSeen, "setup: first navigation shows the optimistic dataset shell").toBe(true);

  const secondSeen = await navigateWatchingForDatasetShell(page, `${ROOT}/en/datasets/moved-z`, {
    selector: "#account-page",
    href: `${ROOT}/en/accounts/z`,
  });
  expect(secondSeen, "the dataset shell shows again after a redirect contradicted it").toBe(false);
});
