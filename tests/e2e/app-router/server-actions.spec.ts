import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

/**
 * Wait for the RSC browser entry to hydrate.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(
      () => !!(window as any).__VINEXT_RSC_ROOT__,
    );
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Server Actions", () => {
  test("like button calls server action and updates count", async ({
    page,
  }) => {
    await page.goto(`${BASE}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");
    await waitForHydration(page);

    // Initial state
    await expect(page.locator('[data-testid="likes"]')).toContainText(
      "Likes:",
    );

    // Click like button — should call incrementLikes server action
    // Use polling to handle initial hydration delay
    await expect(async () => {
      await page.click('[data-testid="like-btn"]');
      const text = await page.locator('[data-testid="likes"]').textContent();
      expect(text).not.toBe("Likes: 0");
    }).toPass({ timeout: 15_000 });

    // Click again — count should increase by 1
    const currentText = await page.locator('[data-testid="likes"]').textContent();
    const currentCount = parseInt(currentText!.replace("Likes: ", ""), 10);
    await page.click('[data-testid="like-btn"]');
    await expect(page.locator('[data-testid="likes"]')).toHaveText(
      `Likes: ${currentCount + 1}`,
      { timeout: 10_000 },
    );
  });

  test("message form calls server action with FormData", async ({ page }) => {
    await page.goto(`${BASE}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");
    await waitForHydration(page);

    // Type a message and submit
    await page.fill('[data-testid="message-input"]', "Hello vinext!");
    await page.click('[data-testid="send-btn"]');

    // Should display the server response
    await expect(page.locator('[data-testid="message-result"]')).toHaveText(
      "Received: Hello vinext!",
      { timeout: 10_000 },
    );
  });

  test("server action page renders without JavaScript", async ({ page }) => {
    // Block JS to verify SSR-only content
    await page.route("**/*.js", (route) => route.abort());
    await page.route("**/*.mjs", (route) => route.abort());

    await page.goto(`${BASE}/actions`);

    await expect(page.locator("h1")).toHaveText("Server Actions");
    await expect(page.locator('[data-testid="likes"]')).toContainText(
      "Likes:",
    );
    await expect(page.locator('[data-testid="like-btn"]')).toBeVisible();
  });
});
