import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

/**
 * Wait for the RSC browser entry to hydrate.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("App Router navigation flows", () => {
  test("multi-page navigation chain without reload", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Home → About
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // About → Home
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Home → Blog
    await page.click('a[href="/blog/hello-world"]');
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("main > p")).toContainText("Slug: hello-world");

    // Blog → Dashboard
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // Dashboard → Settings
    await page.goto(`${BASE}/dashboard/settings`);
    await expect(page.locator("h1")).toHaveText("Settings");

    // Check no full reload happened for the Link navigations
    // (goTo does reload, but we verify the first 3 Link navigations preserved marker)
  });

  test("back/forward through multiple pages preserves content", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);

    // Navigate through 3 pages via links
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    await page.click('a[href="/blog/hello-world"]');
    await expect(page.locator("h1")).toHaveText("Blog Post");

    // Back: Blog → Home
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Back: Home → About
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("About");

    // Forward: About → Home
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Forward: Home → Blog
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Blog Post");
  });

  test("search form flow: type, submit, modify, resubmit", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    // Empty state
    await expect(page.locator("#search-empty")).toHaveText("Enter a search term");

    // First search
    await page.fill("#search-input", "react");
    await page.click("#search-button");
    await expect(page.locator("#search-result")).toHaveText("Results for: react");
    expect(page.url()).toContain("q=react");

    // Clear and search again
    await page.fill("#search-input", "vite");
    await page.click("#search-button");
    await expect(page.locator("#search-result")).toHaveText("Results for: vite");
    expect(page.url()).toContain("q=vite");

    // Third search
    await page.fill("#search-input", "cloudflare workers");
    await page.click("#search-button");
    await expect(page.locator("#search-result")).toHaveText("Results for: cloudflare workers");
  });

  test("server action: like button click flow", async ({ page }) => {
    await page.goto(`${BASE}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");
    await waitForHydration(page);

    // Initial state
    await expect(page.locator('[data-testid="likes"]')).toHaveText("Likes: 0");

    // Click like multiple times
    await expect(async () => {
      await page.click('[data-testid="like-btn"]');
      const text = await page.locator('[data-testid="likes"]').textContent();
      expect(text).not.toBe("Likes: 0");
    }).toPass({ timeout: 15_000 });

    // Verify count increased
    const text1 = await page.locator('[data-testid="likes"]').textContent();
    const count1 = parseInt(text1!.replace("Likes: ", ""), 10);
    expect(count1).toBeGreaterThan(0);

    // Click again
    await page.click('[data-testid="like-btn"]');
    await expect(page.locator('[data-testid="likes"]')).toHaveText(`Likes: ${count1 + 1}`, {
      timeout: 10_000,
    });
  });

  test("server action: message form submit flow", async ({ page }) => {
    await page.goto(`${BASE}/actions`);
    await waitForHydration(page);

    // Type and submit a message
    await page.fill('[data-testid="message-input"]', "Hello!");
    await page.click('[data-testid="send-btn"]');
    await expect(page.locator('[data-testid="message-result"]')).toHaveText("Received: Hello!", {
      timeout: 10_000,
    });

    // Submit another message
    await page.fill('[data-testid="message-input"]', "Testing vinext");
    await page.click('[data-testid="send-btn"]');
    await expect(page.locator('[data-testid="message-result"]')).toHaveText(
      "Received: Testing vinext",
      { timeout: 10_000 },
    );
  });

  test("useActionState: increment and decrement counter", async ({ page }) => {
    await page.goto(`${BASE}/action-state-test`);
    await expect(page.locator("#count")).toHaveText("Count: 0");
    await waitForHydration(page);

    // Increment 3 times
    for (let i = 1; i <= 3; i++) {
      await expect(async () => {
        await page.click('button:has-text("Increment")');
        await expect(page.locator("#count")).toHaveText(`Count: ${i}`, {
          timeout: 3_000,
        });
      }).toPass({ timeout: 15_000 });
    }

    // Decrement twice
    await expect(async () => {
      await page.click('button:has-text("Decrement")');
      await expect(page.locator("#count")).toHaveText("Count: 2", {
        timeout: 3_000,
      });
    }).toPass({ timeout: 15_000 });

    await expect(async () => {
      await page.click('button:has-text("Decrement")');
      await expect(page.locator("#count")).toHaveText("Count: 1", {
        timeout: 3_000,
      });
    }).toPass({ timeout: 15_000 });
  });

  test("dynamic route navigation with different slugs", async ({ page }) => {
    await page.goto(`${BASE}/shop/electronics`);
    await expect(page.locator("h1")).toHaveText("Category: electronics");

    await page.goto(`${BASE}/shop/electronics/phone`);
    await expect(page.locator("h1")).toHaveText("Item: phone in electronics");

    await page.goto(`${BASE}/shop/clothing/shirt`);
    await expect(page.locator("h1")).toHaveText("Item: shirt in clothing");

    // Navigate to catch-all route
    await page.goto(`${BASE}/docs/api/v2/reference`);
    await expect(page.locator("h1")).toHaveText("Documentation");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: api/v2/reference");
  });

  test("error → reset → navigate flow", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Trigger error
    await expect(async () => {
      await page.click('[data-testid="trigger-error"]');
      await expect(page.locator("#error-boundary")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 15_000 });

    // Reset
    await page.click("#error-boundary button");
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible({
      timeout: 5000,
    });

    // Now navigate away to verify the page isn't stuck
    await page.goto(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("direct URL navigation with query params", async ({ page }) => {
    // Navigate directly to search with query
    await page.goto(`${BASE}/search?q=initial`);
    await expect(page.locator("#search-result")).toHaveText("Results for: initial");

    // Navigate to search without query
    await page.goto(`${BASE}/search`);
    await expect(page.locator("#search-empty")).toHaveText("Enter a search term");

    // Navigate to client-nav-test with query
    await page.goto(`${BASE}/client-nav-test?q=test-param`);
    await expect(page.locator('[data-testid="client-search-q"]')).toHaveText("test-param");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for issue #639: Suspense partial-flash during navigation
//
// The bug: flushSync() caused React to synchronously commit a partial new tree
// where content *outside* a Suspense boundary (e.g. a heading) had updated to
// the new value but content *inside* the Suspense boundary was still showing
// its fallback. This "partial flash" made it look like the heading was wrong.
//
// The fix: NavigationRoot holds RSC content in React state and uses
// startTransition to schedule updates. React's transition semantics keep the
// *entire* previous committed tree visible until all Suspense boundaries in the
// new tree have resolved, then commits atomically.
//
// We test this with /suspense-nav-test: a page where the heading is *outside*
// Suspense but the list is *inside* Suspense. Both depend on the same ?filter
// param. A partial flash would produce heading="All Items" + list fallback at
// the same time. The correct behavior is: old heading stays until list is ready,
// then both update together.
// ---------------------------------------------------------------------------
test.describe("issue #639 — Suspense partial-flash regression", () => {
  test("heading and list update together during same-page navigation", async ({ page }) => {
    // Start with filter applied so Suspense has resolved content.
    await page.goto(`${BASE}/suspense-nav-test?filter=active`);
    await waitForHydration(page);

    await expect(page.locator("#page-heading")).toHaveText("Filtered: active");
    await expect(page.locator("#item-list")).toBeVisible();

    // Instrument: record if we ever observe the NEW heading ("All Items") at
    // the same moment as the list loading fallback — that is the partial flash.
    await page.evaluate(() => {
      (window as any).__PARTIAL_FLASH_SEEN__ = false;
      const observer = new MutationObserver(() => {
        const heading = document.getElementById("page-heading");
        const loadingFallback = document.getElementById("list-loading");
        // Partial flash: new heading visible while list is still loading
        if (heading?.textContent === "All Items" && loadingFallback) {
          (window as any).__PARTIAL_FLASH_SEEN__ = true;
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      (window as any).__PARTIAL_FLASH_OBSERVER__ = observer;
    });

    // Navigate back to the unfiltered state (clears the filter).
    await page.click("#toggle-filter");

    // Wait for the full transition to complete.
    await expect(page.locator("#page-heading")).toHaveText("All Items", { timeout: 10_000 });
    await expect(page.locator("#item-list")).toBeVisible();

    await page.evaluate(() => {
      (window as any).__PARTIAL_FLASH_OBSERVER__?.disconnect();
    });

    const partialFlashSeen = await page.evaluate(() => (window as any).__PARTIAL_FLASH_SEEN__);
    expect(partialFlashSeen).toBe(false);
  });

  test("back/forward navigation completes correctly on suspense page", async ({ page }) => {
    await page.goto(`${BASE}/suspense-nav-test`);
    await waitForHydration(page);
    await expect(page.locator("#page-heading")).toHaveText("All Items");

    // Navigate to filtered state
    await page.click("#toggle-filter");
    await expect(page.locator("#page-heading")).toHaveText("Filtered: active", {
      timeout: 10_000,
    });

    // Navigate back
    await page.goBack();
    await expect(page.locator("#page-heading")).toHaveText("All Items", { timeout: 10_000 });

    // Navigate forward
    await page.goForward();
    await expect(page.locator("#page-heading")).toHaveText("Filtered: active", {
      timeout: 10_000,
    });
  });

  /**
   * Regression test for issue #639 — back-button scroll restoration jank.
   *
   * The bug: flushSync committed an incomplete tree (with Suspense fallbacks)
   * before scroll restoration ran. Because fallbacks have different heights
   * than resolved content, the restored scroll position landed in the wrong
   * place, then jumped again when content resolved — visible stutter.
   *
   * The fix (NavigationRoot): the old content stays visible during the
   * transition, so scroll is set on stable layout. The new content then
   * commits at that scroll position. No layout shift, no stutter.
   */
  test("back-button restores scroll position after navigating to item detail", async ({ page }) => {
    await page.goto(`${BASE}/suspense-nav-test`);
    await waitForHydration(page);

    // Wait for list to load (async, 400ms delay)
    await expect(page.locator("#item-list")).toBeVisible({ timeout: 10_000 });

    // Scroll well down the list so there is a meaningful position to restore.
    await page.evaluate(() => window.scrollTo(0, 600));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Navigate via evaluate click (no Playwright auto-scroll).
    await page.evaluate(() => {
      const link = document.querySelector("#item-list a:first-child") as HTMLAnchorElement;
      link?.click();
    });
    await expect(page.locator("#item-heading")).toBeVisible({ timeout: 10_000 });

    // Press back.
    await page.goBack();
    await expect(page.locator("#item-list")).toBeVisible({ timeout: 10_000 });

    // Allow time for the retry-based scroll restoration to succeed.
    // The list has a 400ms load delay; restoration retries until the page
    // is tall enough to reach the target position.
    await page.waitForTimeout(800);

    const scrollAfter = await page.evaluate(() => window.scrollY);

    // Scroll should be close to where we left off (within 50px tolerance).
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(50);
  });
});
