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

  test("onNavigate reports the resolved URL for relative query hrefs", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
      sessionStorage.removeItem("pages-relative-onNavigate-url");
    });

    await page.click('[data-testid="link-relative-query"]');

    await expect(page.locator('[data-testid="current-path"]')).toHaveText("/link-test?page=2");
    expect(page.url()).toBe(`${BASE}/link-test?page=2`);
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    const reportedUrl = await page.evaluate(() =>
      sessionStorage.getItem("pages-relative-onNavigate-url"),
    );
    expect(reportedUrl).toBe("/link-test?page=2");
  });
});

// Ported from Next.js: test/e2e/link-on-navigate-prop/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/link-on-navigate-prop/index.test.ts
//
// Mirrors the upstream OnNavigate scenarios for Pages Router: onClick always
// fires, onNavigate fires only for client-side internal navigation, calling
// `event.preventDefault()` cancels navigation, and modifier-key / target=_blank
// / download / external links skip onNavigate while still firing onClick.
test.describe("Link onNavigate prop (Pages Router, OnNavigate fixture)", () => {
  const PAGE = "/on-navigate-fixture";

  test("toggle-lock button hydrates and updates isLocked", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator("#is-locked")).toHaveText("isLocked: false");
    await page.click("#toggle-lock");
    await expect(page.locator("#is-locked")).toHaveText("isLocked: true");
  });

  test("fires onClick and onNavigate for an internal click", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator("#is-clicked")).toHaveText("isClicked: false");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");

    await page.click("#link-to-subpage");

    await expect(page.locator("#subpage-heading")).toHaveText("Subpage");
  });

  test("cancels navigation when onNavigate calls preventDefault", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.click("#toggle-lock");
    await expect(page.locator("#is-locked")).toHaveText("isLocked: true");

    await page.click("#link-to-subpage");
    // Still on the same page (onNavigate.preventDefault cancelled navigation)
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
    expect(page.url()).toBe(`${BASE}${PAGE}`);
  });

  test("download links fire onClick but not onNavigate", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Block the actual download so the test doesn't hang waiting for a file.
    await page.evaluate(() => {
      document.getElementById("download-link")?.addEventListener("click", (e) => {
        e.preventDefault();
      });
    });

    await page.click("#download-link");
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
  });

  test('target="_blank" links fire onClick but not onNavigate', async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The browser would normally open a new tab; intercept so the test
    // process stays on the original page and we can read its state.
    await page.evaluate(() => {
      document
        .getElementById("external-link-with-target")
        ?.addEventListener("click", (e) => e.preventDefault());
    });

    await page.click("#external-link-with-target");
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
  });
});
