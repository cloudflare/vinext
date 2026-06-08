import { test, expect, type Page, type Request } from "@playwright/test";
import { disableDevErrorOverlay, waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

// Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
// (the Pages Router half — `pages/*` fixtures and the four `pages router` cases)
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
//
// Next.js blocks dangerous URI schemes (javascript:, etc.) in the Pages Router
// `<Link>` click handler and in `router.push`/`router.replace`, surfacing a
// `console.error` containing
//   "has blocked a javascript: URL as a security precaution."
// without ever performing the navigation. Finishes the Pages Router half of
// issue #1576 (the App Router half already lands in
// tests/e2e/app-router/nextjs-compat/javascript-urls.spec.ts).

function createNavigationInterceptor() {
  const navigationRequests: Request[] = [];

  const beforePageLoad = (page: Page) => {
    page.on("request", (request) => {
      if (request.resourceType() === "document") {
        navigationRequests.push(request);
      }
    });
  };

  const getNavigationRequests = () => navigationRequests;

  return { beforePageLoad, getNavigationRequests };
}

async function expectJavascriptUrlBlocked(
  page: Page,
  initialUrl: string,
  getNavigationRequests: () => Request[],
) {
  await expect
    .poll(async () => {
      const logs = await page.evaluate(() => {
        const value = Reflect.get(window, "__VINEXT_TEST_CONSOLE_ERRORS__");
        return Array.isArray(value) ? value.map(String) : [];
      });
      return logs.some((message) =>
        message.includes("has blocked a javascript: URL as a security precaution."),
      );
    })
    .toBe(true);

  const postLoadNavigations = getNavigationRequests().filter(
    (request) => !request.url().includes(new URL(initialUrl).pathname),
  );
  expect(postLoadNavigations).toHaveLength(0);
  expect(page.url()).toBe(initialUrl);
}

test.describe("pages-router javascript-urls", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.set(window, "__VINEXT_TEST_CONSOLE_ERRORS__", []);
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        const value = Reflect.get(window, "__VINEXT_TEST_CONSOLE_ERRORS__");
        if (Array.isArray(value)) {
          value.push(args.map(String).join(" "));
        }
        originalError(...args);
      };
    });
  });

  test("should prevent javascript URLs in pages router Link component", async ({ page }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/link-href`);
    await waitForHydration(page);
    const initialUrl = page.url();

    await page.locator("a").first().click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });

  test("should prevent javascript URLs in pages router Link as prop", async ({ page }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/link-as`);
    await waitForHydration(page);
    const initialUrl = page.url();

    await page.locator("a").first().click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });

  test("should prevent javascript URLs in pages router router.push", async ({ page }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/router-push`);
    await waitForHydration(page);
    const initialUrl = page.url();

    await page.locator("button").click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    // The synchronous `router.push` throw (the #1575 behaviour that surfaces the
    // console.error) is caught by the dev error overlay, whose backdrop would
    // otherwise intercept the safe-navigation click below. Suppress it — the
    // security block has already been asserted above.
    await disableDevErrorOverlay(page);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });

  test("should prevent javascript URLs in pages router router.replace", async ({ page }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/router-replace`);
    await waitForHydration(page);
    const initialUrl = page.url();

    await page.locator("button").click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    // The synchronous `router.replace` throw (the #1575 behaviour that surfaces
    // the console.error) is caught by the dev error overlay, whose backdrop
    // would otherwise intercept the safe-navigation click below. Suppress it —
    // the security block has already been asserted above.
    await disableDevErrorOverlay(page);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });
});
