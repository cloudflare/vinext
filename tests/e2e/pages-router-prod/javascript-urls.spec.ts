import { test, expect, type Page, type Request } from "@playwright/test";
import { waitForHydration } from "../helpers";

/**
 * Production-build E2E coverage for Pages Router `javascript:` URL blocking.
 *
 * Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
 * (the Pages Router half — the four `pages router` cases)
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
 *
 * The companion dev-server spec lives at
 * tests/e2e/pages-router/javascript-urls.spec.ts and runs against `vp dev`.
 * The Next.js deploy suite, however, exercises these scenarios against a
 * PRODUCTION build (`vinext build` + `vinext start`), where the dev error
 * overlay is absent and the client bundle is minified. This spec re-runs the
 * same four scenarios against the production server (port 4175, started by the
 * `pages-router-prod` webServer in playwright.config.ts) so a prod-only
 * regression in the Link dangerous-click handler or the router push/replace
 * guard is caught here rather than only in the deploy suite.
 *
 * Each scenario must:
 *   (a) NOT navigate (no document request, URL unchanged, `boom` never reached)
 *   (b) emit a console.error containing
 *       "has blocked a javascript: URL as a security precaution."
 * matching App Router behaviour.
 */
const BASE = "http://localhost:4175";

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

test.describe("pages-router-prod javascript-urls", () => {
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

    // No dev error overlay in a production build, so the synchronous
    // router.push throw does not paint a backdrop over the page — the safe
    // navigation below can click directly.
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

    // No dev error overlay in a production build (see router.push above).
    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });
});
