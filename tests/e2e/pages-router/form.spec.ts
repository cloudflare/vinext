/**
 * Pages Router E2E tests for next/form (<Form>) soft navigation.
 *
 * Mirrors the app-router/form.spec.ts coverage for the Pages Router.
 * The fixture page is: tests/fixtures/pages-basic/pages/form-test.tsx
 */
import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

async function installPageLoadCounter(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const key = "__FORM_PAGE_LOAD_COUNT__";
    const count = Number(window.sessionStorage.getItem(key) ?? "0") + 1;
    window.sessionStorage.setItem(key, String(count));
  });
}

test.describe("next/form Pages Router GET interception", () => {
  test("form page renders with empty state on SSR", async ({ page }) => {
    await page.goto(`${BASE}/form-test`);
    await expect(page.locator("h1")).toHaveText("Form Test");
    await expect(page.locator("#search-empty")).toHaveText("Enter a search term");
    await expect(page.locator("#search-form")).toBeVisible();
    await expect(page.locator("#search-input")).toBeVisible();
  });

  test("form page renders with query param from SSR", async ({ page }) => {
    await page.goto(`${BASE}/form-test?q=hello`);
    await expect(page.locator("h1")).toHaveText("Form Test");
    await expect(page.locator("#search-result")).toHaveText("Results for: hello");
  });

  test("Form GET submission soft-navigates without full page reload", async ({ page }) => {
    await installPageLoadCounter(page);
    await page.goto(`${BASE}/form-test`);
    await expect(page.locator("h1")).toHaveText("Form Test");
    await waitForHydration(page);

    await page.fill("#search-input", "react");
    await page.locator("#search-button").click({ noWaitAfter: true });

    await expect(page.locator("#search-result")).toHaveText("Results for: react", {
      timeout: 10_000,
    });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/form-test");
    expect(url.searchParams.get("q")).toBe("react");

    // Verify no full page reload occurred (page load counter stays at 1).
    const count = await page.evaluate(() =>
      window.sessionStorage.getItem("__FORM_PAGE_LOAD_COUNT__"),
    );
    expect(count).toBe("1");
  });

  test("replace prop: Form submission replaces history instead of pushing", async ({ page }) => {
    await page.goto(`${BASE}/form-test`);
    await expect(page.locator("h1")).toHaveText("Form Test");
    await waitForHydration(page);

    // Navigate somewhere first so there is a history entry to compare against.
    await page.goto(`${BASE}/`);
    await page.goto(`${BASE}/form-test`);
    await waitForHydration(page);

    const historyLengthBefore = await page.evaluate(() => window.history.length);

    await page.fill("#replace-input", "replace-query");
    await page.locator("#replace-button").click({ noWaitAfter: true });

    await expect(page.locator("#search-result")).toHaveText("Results for: replace-query", {
      timeout: 10_000,
    });

    // With replace, history length should not increase.
    const historyLengthAfter = await page.evaluate(() => window.history.length);
    expect(historyLengthAfter).toBe(historyLengthBefore);
  });

  test("onSubmit calling preventDefault skips client-side navigation", async ({ page }) => {
    await page.goto(`${BASE}/form-test`);
    await expect(page.locator("h1")).toHaveText("Form Test");
    await waitForHydration(page);

    const urlBefore = page.url();
    await page.locator("#prevent-button").click({ noWaitAfter: true });

    // URL should remain unchanged since preventDefault was called.
    await page.waitForTimeout(500);
    expect(page.url()).toBe(urlBefore);
    await expect(page.locator("#search-empty")).toBeVisible();
  });

  test("multiple Form submissions work sequentially without full reload", async ({ page }) => {
    await installPageLoadCounter(page);
    await page.goto(`${BASE}/form-test`);
    await waitForHydration(page);

    // First search
    await page.fill("#search-input", "first");
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: first", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("q=first");

    // Second search
    await page.fill("#search-input", "second");
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: second", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("q=second");

    // No full page reload across both submissions.
    const count = await page.evaluate(() =>
      window.sessionStorage.getItem("__FORM_PAGE_LOAD_COUNT__"),
    );
    expect(count).toBe("1");
  });
});
