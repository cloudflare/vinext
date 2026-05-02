import { test, expect, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

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

test.describe("javascript-urls", () => {
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

  // Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  test("should prevent javascript URLs in server action redirect through onClick", async ({
    page,
  }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/action-redirect-onclick`);
    await waitForAppRouterHydration(page);
    const initialUrl = page.url();

    await page.getByRole("button", { name: "redirect via onclick action" }).click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });

  // Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
  test("should prevent javascript URLs in server action redirect through form action", async ({
    page,
  }) => {
    const { beforePageLoad, getNavigationRequests } = createNavigationInterceptor();
    beforePageLoad(page);

    await page.goto(`${BASE}/nextjs-compat/javascript-urls/action-redirect-form`);
    await waitForAppRouterHydration(page);
    const initialUrl = page.url();

    await page.getByRole("button", { name: "redirect via form action" }).click();
    await expectJavascriptUrlBlocked(page, initialUrl, getNavigationRequests);

    await page.locator('a[href="/nextjs-compat/javascript-urls/safe"]').click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/javascript-urls/safe`);
  });
});
