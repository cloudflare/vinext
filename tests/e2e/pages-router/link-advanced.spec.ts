import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Link advanced props (Pages Router)", () => {
  test("scroll={false} preserves scroll position", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Intercept window.scrollTo to detect if scroll-to-top was called
    await page.evaluate(() => {
      (window as any).__scrollToTopCalled = false;
      const orig = window.scrollTo.bind(window);
      window.scrollTo = (...args: any[]) => {
        // Detect scrollTo(0, 0) or scrollTo({ top: 0 })
        if (
          (args[0] === 0 && args[1] === 0) ||
          (typeof args[0] === "object" && args[0]?.top === 0)
        ) {
          (window as any).__scrollToTopCalled = true;
        }
        return orig(...args);
      };
    });

    // Scroll down to the links section (past the 200vh tall content)
    await page.locator('[data-testid="links"]').scrollIntoViewIfNeeded();

    // Get current scroll position
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Click the no-scroll link
    await page.click('[data-testid="link-no-scroll"]');
    await expect(page.locator("h1")).toHaveText("About");

    // scroll={false} means scrollTo(0,0) should NOT have been called
    const scrollToTopCalled = await page.evaluate(() => (window as any).__scrollToTopCalled);
    expect(scrollToTopCalled).toBe(false);
  });

  test("replace does not add to browser history", async ({ page }) => {
    // Start at home, then go to link-test
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Navigate to link-test page
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Scroll to links
    await page.locator('[data-testid="links"]').scrollIntoViewIfNeeded();

    // Click replace link — should navigate to /about without adding history
    await page.click('[data-testid="link-replace"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Going back should NOT go to link-test (because replace was used)
    // It should go to the page before link-test (the home page)
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
  });

  test("as prop renders correct href on the anchor element", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The anchor should use the "as" value for its href
    const href = await page.getAttribute('[data-testid="link-as"]', "href");
    expect(href).toBe("/blog/test-post");
  });

  test("onClick with preventDefault blocks navigation", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Click the link with preventDefault
    await page.click('[data-testid="link-prevent"]');

    // Navigation should NOT have happened — still on link-test
    await expect(page.locator("h1")).toHaveText("Link Advanced Props Test");

    // The prevented-message should be visible
    await expect(page.locator('[data-testid="prevented-message"]')).toHaveText(
      "Navigation was prevented",
    );
  });

  test('target="_blank" has correct attributes', async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    const link = page.locator('[data-testid="link-blank"]');
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("href", "/about");
  });
});
