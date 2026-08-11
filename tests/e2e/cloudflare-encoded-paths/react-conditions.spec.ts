import { expect, test } from "@playwright/test";

type ReactConditions = {
  react: "default" | "react-server";
  reactDom: "default" | "react-server";
};

async function expectPageConditions(
  page: import("@playwright/test").Page,
  pathname: string,
  expected: ReactConditions["react"],
) {
  await page.goto(pathname);
  await expect(page.getByTestId("react-condition")).toHaveText(expected);
  await expect(page.getByTestId("react-dom-condition")).toHaveText(expected);
}

async function expectApiConditions(
  request: import("@playwright/test").APIRequestContext,
  pathname: string,
  expected: ReactConditions["react"],
) {
  const response = await request.get(pathname);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ react: expected, reactDom: expected });
}

// Ported from Next.js: test/e2e/react-version/react-version.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/react-version/react-version.test.ts
test.describe("React export conditions in a hybrid Cloudflare Worker", () => {
  test("uses react-server for App Router server components", async ({ page }) => {
    await expectPageConditions(page, "/react-conditions/server", "react-server");
  });

  test("uses default for App Router client components", async ({ page }) => {
    await expectPageConditions(page, "/react-conditions/client", "default");
  });

  test("uses react-server for App Router route handlers", async ({ request }) => {
    await expectApiConditions(request, "/api/app-react-conditions", "react-server");
  });

  test("uses default for Pages Router pages", async ({ page }) => {
    await expectPageConditions(page, "/react-conditions", "default");
  });

  test("uses default for Pages Router APIs", async ({ request }) => {
    await expectApiConditions(request, "/api/pages-react-conditions", "default");
  });
});
