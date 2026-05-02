import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("Server Actions", () => {
  test("like button calls server action and updates count", async ({ page }) => {
    await page.goto(`${BASE}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");
    await waitForAppRouterHydration(page);

    // Initial state
    await expect(page.locator('[data-testid="likes"]')).toContainText("Likes:");

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
    await expect(page.locator('[data-testid="likes"]')).toHaveText(`Likes: ${currentCount + 1}`, {
      timeout: 10_000,
    });
  });

  test("message form calls server action with FormData", async ({ page }) => {
    await page.goto(`${BASE}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");
    await waitForAppRouterHydration(page);

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
    await expect(page.locator('[data-testid="likes"]')).toContainText("Likes:");
    await expect(page.locator('[data-testid="like-btn"]')).toBeVisible();
  });

  // Ported from Next.js:
  // test/e2e/app-dir/actions/app-action-progressive-enhancement.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action-progressive-enhancement.test.ts
  test("server action formData redirect works without JavaScript", async ({ browser }) => {
    let actionResponseStatus: number | undefined;
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/nextjs-compat/action-progressive") {
        actionResponseStatus = response.status();
      }
    });

    try {
      await page.goto(`${BASE}/nextjs-compat/action-progressive`);
      await page.fill("#name", "test");
      await page.click("#submit");

      await expect(page).toHaveURL(
        `${BASE}/nextjs-compat/action-progressive/result?name=test&hidden-info=hi`,
      );
      await expect(page.locator("h1")).toHaveText("Action Progressive Result");
      expect(actionResponseStatus).toBe(303);
    } finally {
      await context.close();
    }
  });

  test("server action with redirect() navigates to target page", async ({ page }) => {
    await page.goto(`${BASE}/action-redirect-test`);
    await expect(page.locator("h1")).toHaveText("Action Redirect Test");
    await waitForAppRouterHydration(page);

    // Click the redirect button — should invoke redirectAction() which calls redirect("/about")
    await page.click('[data-testid="redirect-btn"]');

    // Should navigate to /about
    await expect(page).toHaveURL(/\/about/, { timeout: 10_000 });
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("server action cookie writes do not make the rerender path mutable", async ({ page }) => {
    test.slow();
    await page.goto(`${BASE}/nextjs-compat/action-cookie-phase`);
    await expect(page.locator("h1")).toHaveText("Action Cookie Phase");
    await waitForAppRouterHydration(page);
    await expect(page.locator("#cookie-value")).toHaveText("missing");
    await expect(page.locator("#cookie-error")).toContainText(
      "Cookies can only be modified in a Server Action or Route Handler",
    );

    await page.click("#submit-action");
    const readActionCookie = async () =>
      (await page.context().cookies()).find((cookie) => cookie.name === "action-cookie")?.value ??
      null;

    let cookieSet = false;
    try {
      await expect.poll(readActionCookie, { timeout: 5_000 }).toBe("from-action");
      cookieSet = true;
    } catch {
      // Cold compile can swallow the first submit in dev; retry once after
      // the route/action module is warm.
    }

    if (!cookieSet) {
      await page.click("#submit-action");
      await expect.poll(readActionCookie, { timeout: 20_000 }).toBe("from-action");
    }

    await page.reload();
    await expect(page.locator("#cookie-value")).toHaveText("from-action");
    await expect(page.locator("#cookie-error")).toContainText(
      "Cookies can only be modified in a Server Action or Route Handler",
    );
  });

  test("action-redirect-test page SSR renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/action-redirect-test`);
    await expect(page.locator("h1")).toHaveText("Action Redirect Test");
    await expect(page.locator('[data-testid="redirect-btn"]')).toBeVisible();
  });
});

test.describe("useActionState", () => {
  test("action-state-test page SSR renders with initial state", async ({ page }) => {
    await page.goto(`${BASE}/action-state-test`);
    await expect(page.locator("h1")).toHaveText("useActionState Test");
    await expect(page.locator("#count")).toHaveText("Count: 0");
  });

  test("useActionState counter increments via server action", async ({ page }) => {
    await page.goto(`${BASE}/action-state-test`);
    await expect(page.locator("h1")).toHaveText("useActionState Test");

    // Wait for hydration
    await expect(async () => {
      const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
      expect(ready).toBe(true);
    }).toPass({ timeout: 10_000 });

    // Initial state
    await expect(page.locator("#count")).toHaveText("Count: 0");

    // Click increment — use polling to handle server action latency
    await expect(async () => {
      await page.click('button:has-text("Increment")');
      await expect(page.locator("#count")).toHaveText("Count: 1", { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });

    // Click again — count should go to 2
    await expect(async () => {
      await page.click('button:has-text("Increment")');
      await expect(page.locator("#count")).toHaveText("Count: 2", { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
  });

  test("useActionState counter decrements via server action", async ({ page }) => {
    await page.goto(`${BASE}/action-state-test`);
    await expect(page.locator("h1")).toHaveText("useActionState Test");

    await expect(async () => {
      const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
      expect(ready).toBe(true);
    }).toPass({ timeout: 10_000 });

    // Click decrement from 0 — should go to -1
    await expect(async () => {
      await page.click('button:has-text("Decrement")');
      await expect(page.locator("#count")).toHaveText("Count: -1", { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
  });

  test("useActionState: redirect does not cause undefined state (issue #589)", async ({ page }) => {
    await page.goto(`${BASE}/action-state-redirect`);
    await expect(page.locator("h1")).toHaveText("useActionState Redirect Test");
    await waitForAppRouterHydration(page);

    // Initial state should be { success: false }
    await expect(async () => {
      const stateText = await page.locator("#state").textContent();
      expect(stateText).toContain('"success":false');
    }).toPass({ timeout: 5_000 });

    // Click the redirect button — should navigate without state becoming undefined
    await page.click("#redirect-btn");

    // Should navigate to /action-state-test without crashing
    await expect(page).toHaveURL(/\/action-state-test$/);
    await expect(page.locator("h1")).toHaveText("useActionState Test");
  });
});
