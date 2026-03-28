import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function disableViteErrorOverlay(page: import("@playwright/test").Page) {
  // Vite's dev error overlay can sometimes appear and intercept clicks.
  await page
    .addStyleTag({
      content: "vite-error-overlay{display:none !important; pointer-events:none !important;}",
    })
    .catch(() => {
      // best effort
    });
}

/**
 * Wait for RSC hydration.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });

  await disableViteErrorOverlay(page);
}

async function installPageLoadCounter(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const key = "__FORM_PAGE_LOAD_COUNT__";
    const count = Number(window.sessionStorage.getItem(key) ?? "0") + 1;
    window.sessionStorage.setItem(key, String(count));
  });
}

test.describe("next/form GET interception", () => {
  test("search page renders with empty state on SSR", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await expect(page.locator("#search-empty")).toHaveText("Enter a search term");
    await expect(page.locator("#search-form")).toBeVisible();
    await expect(page.locator("#search-input")).toBeVisible();
  });

  test("search page renders with query param from SSR", async ({ page }) => {
    await page.goto(`${BASE}/search?q=hello`);
    await expect(page.locator("h1")).toHaveText("Search");
    await expect(page.locator("#search-result")).toHaveText("Results for: hello");
  });

  test("Form GET submission updates URL query params", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    await page.fill("#search-input", "react");
    await expect(page.locator("#search-input")).toHaveValue("react");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });

    await expect(page.locator("#search-result")).toHaveText("Results for: react", {
      timeout: 10_000,
    });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("react");
  });

  test("Form GET submission includes hidden inputs in the destination URL", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    await page.fill("#search-input-with-query", "react");
    await expect(page.locator("#search-input-with-query")).toHaveValue("react");
    await page.locator("#search-button-with-query").click({ noWaitAfter: true });

    await expect(page.locator("#search-result")).toHaveText("Results for: react", {
      timeout: 10_000,
    });
    await expect(page.locator("#search-lang")).toHaveText("Lang: en");
    await expect
      .poll(() => new URL(page.url()).search, { timeout: 10_000 })
      .toBe("?lang=en&q=react");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("q")).toBe("react");
    expect(url.search).toBe("?lang=en&q=react");
  });

  test("Form GET submission honors submitter formAction and includes submitter name/value", async ({
    page,
  }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    await page.fill("#search-input-with-submitter-action", "button");
    await expect(page.locator("#search-input-with-submitter-action")).toHaveValue("button");
    await page.locator("#search-button-with-submitter-action").click({ noWaitAfter: true });

    await expect(page.locator("h1")).toHaveText("Search Alt");
    await expect(page.locator("#search-result")).toHaveText("Results for: button", {
      timeout: 10_000,
    });
    await expect(page.locator("#search-lang")).toHaveText("Lang: fr");
    await expect(page.locator("#search-source")).toHaveText("Source: submitter-action");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/search-alt");
    expect(url.searchParams.get("lang")).toBe("fr");
    expect(url.searchParams.get("q")).toBe("button");
    expect(url.searchParams.get("source")).toBe("submitter-action");
    expect(url.search).toBe("?lang=fr&q=button&source=submitter-action");
  });

  test("Form submission honors submitter formMethod GET on a POST form", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    await page.fill("#search-input-post-with-get-submitter", "override");
    await expect(page.locator("#search-input-post-with-get-submitter")).toHaveValue("override");
    await page.locator("#search-button-post-with-get-submitter").click({ noWaitAfter: true });

    await expect(page.locator("h1")).toHaveText("Search Alt");
    await expect(page.locator("#search-result")).toHaveText("Results for: override", {
      timeout: 10_000,
    });
    await expect(page.locator("#search-lang")).toHaveText("Lang: de");
    await expect(page.locator("#search-source")).toHaveText("Source: submitter-method");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/search-alt");
    expect(url.searchParams.get("lang")).toBe("de");
    expect(url.searchParams.get("q")).toBe("override");
    expect(url.searchParams.get("source")).toBe("submitter-method");
    expect(url.search).toBe("?lang=de&q=override&source=submitter-method");
  });

  test("multiple Form submissions work sequentially", async ({ page }) => {
    await installPageLoadCounter(page);
    await page.goto(`${BASE}/search`);
    await waitForHydration(page);

    // First search
    await page.fill("#search-input", "first");
    await expect(page.locator("#search-input")).toHaveValue("first");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: first", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/search?q=first");

    // Second search
    await page.fill("#search-input", "second");
    await expect(page.locator("#search-input")).toHaveValue("second");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: second", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/search?q=second");

    // No full page reload across both
    await expect
      .poll(() => page.evaluate(() => window.sessionStorage.getItem("__FORM_PAGE_LOAD_COUNT__")), {
        timeout: 10_000,
      })
      .toBe("1");
  });
});
