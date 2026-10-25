import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4181";

// app-with-src has no forbidden.tsx or unauthorized.tsx, so forbidden() and
// unauthorized() render Next.js's built-in 403 and 401 pages at the root
// segment, inside the root layout. A first-layer route group inherits them,
// so they render inside the group's layout too.
// Ported from Next.js: test/e2e/app-dir/forbidden/default/forbidden-default.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/default/forbidden-default.test.ts
// and test/e2e/app-dir/unauthorized/default/unauthorized-default.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/unauthorized/default/unauthorized-default.test.ts

const FORBIDDEN = { status: 403, message: "This page could not be accessed." };
const UNAUTHORIZED = { status: 401, message: "You're not authorized to access this page." };

const CASES = [
  {
    name: "a page's forbidden()",
    path: "/builtin-access/forbidden",
    linkId: "navigate-forbidden",
    ...FORBIDDEN,
    inGroup: false,
  },
  {
    name: "a page's unauthorized()",
    path: "/builtin-access/unauthorized",
    linkId: "navigate-unauthorized",
    ...UNAUTHORIZED,
    inGroup: false,
  },
  {
    // Thrown while the client renders, so the client tree's root boundary
    // catches it on navigation.
    name: "a client page's forbidden()",
    path: "/builtin-access/client-forbidden",
    linkId: "navigate-client-forbidden",
    ...FORBIDDEN,
    inGroup: false,
  },
  {
    name: "a layout's forbidden()",
    path: "/builtin-access/layout-forbidden",
    linkId: "navigate-layout-forbidden",
    ...FORBIDDEN,
    inGroup: false,
  },
  {
    name: "a first-layer route group page's forbidden()",
    path: "/group-dynamic/403",
    linkId: "navigate-group-forbidden",
    ...FORBIDDEN,
    inGroup: true,
  },
  {
    name: "a first-layer route group page's unauthorized()",
    path: "/group-dynamic/401",
    linkId: "navigate-group-unauthorized",
    ...UNAUTHORIZED,
    inGroup: true,
  },
];

async function expectBuiltInPage(
  page: Page,
  { status, message, inGroup }: { status: number; message: string; inGroup: boolean },
) {
  await expect(page.locator("h1.next-error-h1")).toHaveText(String(status));
  await expect(page.locator("h2")).toHaveText(message);
  await expect(page).toHaveTitle(`${status}: ${message}`);
  await expect(page.locator('html[lang="en"]')).toHaveCount(1);
  await expect(page.locator(".group-root-layout")).toHaveCount(inGroup ? 1 : 0);
  // The built-in page replaces every layout below the root segment.
  await expect(page.locator("#builtin-access-layout")).toHaveCount(0);
}

test.describe("built-in forbidden and unauthorized pages", () => {
  for (const testCase of CASES) {
    test(`renders the built-in ${testCase.status} page for ${testCase.name} on load`, async ({
      page,
    }) => {
      const response = await page.goto(`${BASE}${testCase.path}`);
      expect(response?.status()).toBe(testCase.status);
      await expectBuiltInPage(page, testCase);
    });

    test(`renders the built-in ${testCase.status} page for ${testCase.name} on navigation`, async ({
      page,
    }) => {
      await page.goto(`${BASE}/builtin-access`);
      await expect(page.locator("#builtin-access-home")).toBeVisible();
      await waitForAppRouterHydration(page);

      await page.locator(`#${testCase.linkId}`).click();

      await expect(page).toHaveURL(`${BASE}${testCase.path}`);
      await expectBuiltInPage(page, testCase);
    });
  }

  test("renders the group page for an allowed id", async ({ page }) => {
    const response = await page.goto(`${BASE}/group-dynamic/123`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#page")).toHaveText("group-dynamic [id]");
    await expect(page.locator(".group-root-layout")).toHaveCount(1);
  });
});
