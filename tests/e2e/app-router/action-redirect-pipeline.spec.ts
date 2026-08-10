import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ACTION_PATH = "/nextjs-compat/action-redirect-middleware";

async function markCurrentDocument(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, "__ACTION_REDIRECT_PIPELINE_DOCUMENT__", "preserved");
  });
}

async function expectDocumentPreserved(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__ACTION_REDIRECT_PIPELINE_DOCUMENT__")))
    .toBe("preserved");
}

test.describe("Server Action redirect target pipeline", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}${ACTION_PATH}`);
    await waitForAppRouterHydration(page);
    await markCurrentDocument(page);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/server-actions-redirect-middleware-rewrite/
  // server-actions-redirect-middleware-rewrite.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-redirect-middleware-rewrite/server-actions-redirect-middleware-rewrite.test.ts
  test("resolves middleware rewrites inside the action response", async ({ page }) => {
    await page.click("#redirect-to-middleware-rewrite");

    await expect(page).toHaveURL(`${BASE}/middleware-rewrite`);
    await expect(page.getByText("Welcome to App Router", { exact: true })).toBeVisible();
    await expectDocumentPreserved(page);
  });

  test("resolves next.config rewrites inside the action response", async ({ page }) => {
    await page.click("#redirect-to-config-rewrite");

    await expect(page).toHaveURL(`${BASE}/config-rewrite`);
    await expect(page.getByText("Welcome to App Router", { exact: true })).toBeVisible();
    await expectDocumentPreserved(page);
  });

  test("follows middleware redirects before streaming the final Flight payload", async ({
    page,
  }) => {
    await page.click("#redirect-to-middleware-redirect");

    await expect(page).toHaveURL(`${BASE}/middleware-redirect`);
    await expect(page.getByText("About", { exact: true })).toBeVisible();
    await expectDocumentPreserved(page);
  });

  test("follows next.config redirects before streaming the final Flight payload", async ({
    page,
  }) => {
    await page.click("#redirect-to-config-redirect");

    await expect(page).toHaveURL(`${BASE}/redirect-test-config`);
    await expect(page.getByText("About", { exact: true })).toBeVisible();
    await expectDocumentPreserved(page);
  });

  test("carries target config headers on the action response", async ({ page }) => {
    const actionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === ACTION_PATH,
    );
    await page.click("#redirect-to-about");

    const headers = (await actionResponse).headers();
    expect(headers["x-page-header"]).toBe("about-page");
    expect(headers["x-action-source-only"]).toBe("yes");
    expect(headers["x-action-target-saw-source"]).toBe("yes");
    expect(headers["x-action-header-collision"]).toBe("target");
    await expect(page).toHaveURL(`${BASE}/about`);
    await expectDocumentPreserved(page);
  });

  test("falls back to a hard navigation for a Pages Router target", async ({ page }) => {
    await page.click("#redirect-to-pages-route");

    await expect(page).toHaveURL(`${BASE}/old-school`);
    await expect(page.getByText("Old School Pages Directory", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, "__ACTION_REDIRECT_PIPELINE_DOCUMENT__")),
    ).toBeUndefined();
  });

  test("does not stream a middleware-blocked target", async ({ page }) => {
    await page.click("#redirect-to-blocked");

    await expect(page).toHaveURL(`${BASE}/admin`);
    await expect(page.getByText("Protected admin content", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Blocked by middleware", { exact: false })).toBeVisible();
  });

  test("streams the safe 404 Flight response for an encoded static alias", async ({ page }) => {
    await page.click("#redirect-to-encoded-blocked");

    await expect(page).toHaveURL(`${BASE}/adm%69n`);
    await expect(page.getByText("404 - Page Not Found", { exact: true })).toBeVisible();
    await expect(page.getByText("Protected admin content", { exact: true })).toHaveCount(0);
    await expectDocumentPreserved(page);
  });
});
