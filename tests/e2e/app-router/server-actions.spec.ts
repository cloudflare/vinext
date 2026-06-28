import { test, expect } from "@playwright/test";
import { RSC_FORM_STATE_GLOBAL } from "../../../packages/vinext/src/server/app-browser-hydration";
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

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("server action posts to the visible route and exposes text/plain failures", async ({
    page,
  }) => {
    await page.route("**/nextjs-compat/action-response-semantics", async (route) => {
      const headers = await route.request().allHeaders();
      if (headers["next-action"]) {
        await route.fulfill({
          status: 500,
          contentType: "text/plain",
          body: "Custom error!",
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${BASE}/nextjs-compat/action-response-semantics`);
    await waitForAppRouterHydration(page);
    await page.click("#complete-action");

    await expect(page.locator("#action-error")).toHaveText("Custom error!");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("server action exposes a stable error for invalid action response content-type", async ({
    page,
  }) => {
    await page.route("**/nextjs-compat/action-response-semantics", async (route) => {
      const headers = await route.request().allHeaders();
      if (headers["next-action"]) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Custom error!" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${BASE}/nextjs-compat/action-response-semantics`);
    await waitForAppRouterHydration(page);
    await page.click("#complete-action");

    await expect(page.locator("#action-error")).toHaveText(
      "An unexpected response was received from the server.",
    );
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("server action notFound renders the route not-found boundary", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-response-semantics`);
    await waitForAppRouterHydration(page);
    await page.click("#missing-action");

    await expect(page.locator("#action-not-found")).toHaveText("Action not found boundary");
    await expect(page.locator('meta[name="robots"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("same-origin server action redirects complete in a single POST response", async ({
    page,
  }) => {
    const actionResponses: number[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.method() === "POST" &&
        new URL(response.url()).pathname === "/nextjs-compat/action-response-semantics"
      ) {
        actionResponses.push(response.status());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-response-semantics`);
    await waitForAppRouterHydration(page);
    await page.click("#redirect-action");

    await expect(page).toHaveURL(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
    expect(actionResponses).toEqual([303]);
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action-node-middleware.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action-node-middleware.test.ts
  test("server action redirects merge action cookies and strip next-action from the target render", async ({
    page,
  }) => {
    const actionResponses: number[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.method() === "POST" &&
        new URL(response.url()).pathname === "/nextjs-compat/action-redirect-cookies"
      ) {
        actionResponses.push(response.status());
      }
    });

    await page.context().addCookies([
      {
        name: "stale",
        value: "1",
        url: BASE,
      },
    ]);

    await page.goto(`${BASE}/nextjs-compat/action-redirect-cookies`);
    await waitForAppRouterHydration(page);
    await page.click("#redirect-with-cookie-mutation");

    await expect(page).toHaveURL(`${BASE}/nextjs-compat/action-redirect-cookies/target?baz=1`);
    await expect(page.locator("#target-theme")).toHaveText("dark");
    await expect(page.locator("#target-stale")).toHaveText("missing");
    await expect(page.locator("#target-baz")).toHaveText("1");
    expect(actionResponses).toEqual([303]);
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("stale child-route server action redirects return a 200 wrapper response", async ({
    page,
  }) => {
    let redirectResponseStatus: number | undefined;
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.method() === "POST" &&
        response.headers()["x-action-redirect"] &&
        new URL(response.url()).pathname === "/nextjs-compat/action-forwarded-redirect/other"
      ) {
        redirectResponseStatus = response.status();
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-forwarded-redirect`);
    await waitForAppRouterHydration(page);
    await page.click("#run-forwarded-redirect");
    await Promise.all([
      page.waitForURL(`${BASE}/nextjs-compat/action-forwarded-redirect/other`),
      page.click("#go-forwarded-redirect-other"),
    ]);
    await expect(page.locator("#forwarded-redirect-other")).toHaveText("Forwarded Redirect Other");

    await expect(async () => {
      expect(redirectResponseStatus).toBe(200);
    }).toPass({ timeout: 10_000 });
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/action-forwarded-redirect`);
    await expect(page.locator("#run-forwarded-redirect")).toBeVisible();
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  test("cross-runtime server action redirects return a 200 wrapper response", async ({ page }) => {
    let redirectResponseStatus: number | undefined;
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.method() === "POST" &&
        response.headers()["x-action-redirect"] &&
        new URL(response.url()).pathname === "/nextjs-compat/action-forwarded-redirect/edge/other"
      ) {
        redirectResponseStatus = response.status();
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-forwarded-redirect/edge`);
    await waitForAppRouterHydration(page);
    await page.click("#run-cross-runtime-redirect");
    await page.click("#go-cross-runtime-other");
    await expect(page.locator("#cross-runtime-other")).toHaveText("Cross Runtime Other");

    await expect(async () => {
      expect(redirectResponseStatus).toBe(200);
    }).toPass({ timeout: 10_000 });
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/action-forwarded-redirect/node`);
    await expect(page.locator("#cross-runtime-node-target")).toHaveText(
      "Cross Runtime Node Target",
    );
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

  // Matches Next.js v16.2.6 action rerender ordering in action-handler.ts:
  // synchronize mutable cookies, update workStore.isDraftMode, then rerender.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/action-handler.ts
  test("same-route action rerenders apply draft mode before rebuilding cache context", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/action-draft-cache`);
    await waitForAppRouterHydration(page);

    const initialCachedData = await page.locator("#cached-data").textContent();
    await expect(page.locator("#draft-mode-enabled")).toHaveText("false");

    await page.click("#enable-draft");
    await expect(page.locator("#draft-mode-enabled")).toHaveText("true");
    await expect(page.locator("#cached-data")).not.toHaveText(initialCachedData ?? "");

    await page.click("#disable-draft");
    await expect(page.locator("#draft-mode-enabled")).toHaveText("false");
    await expect(page.locator("#cached-data")).toHaveText(initialCachedData ?? "");
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

  // Ported from Next.js' progressive action form-state path:
  // packages/next/src/server/app-render/action-handler.ts decodes form state
  // and packages/next/src/server/app-render/use-flight-response.tsx serializes
  // it for hydrateRoot().
  test("useActionState preserves returned state for progressive form submissions", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE}/action-state-test`);
      await page.click('button:has-text("Increment")');

      await expect(page.locator("#count")).toHaveText("Count: 1");
      const html = await page.content();
      expect(html).toContain(RSC_FORM_STATE_GLOBAL);
    } finally {
      await context.close();
    }
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

test.describe("Server action forwarding loop guard", () => {
  test("middleware rewrite of action POST does not hang (no forwarding loop)", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-forward-loop`);
    await expect(page.locator("h1")).toHaveText("Action Forward Loop Test");
    await waitForAppRouterHydration(page);

    // Click the action button. Middleware rewrites POST to rewrite-target page,
    // but vinext's single-worker bundle still finds the action locally.
    // The action should succeed without any infinite loop / timeout.
    await page.click("#run-action");

    // Wait for action result to appear (or the boundary text if the action fails)
    await expect(async () => {
      const text = await page.locator("#action-result").textContent();
      expect(text).toContain("action-ok");
    }).toPass({ timeout: 10_000 });
  });

  // This tests the pre-existing "unknown action ID" path, not the new
  // x-action-forwarded guard. In vinext's single-worker model the action is
  // found locally, so the guard cannot be triggered organically via E2E.
  test("stale action ID returns 404 with x-nextjs-action-not-found header", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-forward-loop`);
    await waitForAppRouterHydration(page);

    const response = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/nextjs-compat/action-forward-loop`, {
        method: "POST",
        headers: {
          "x-rsc-action": "stale-action-id",
          "content-type": "text/plain;charset=UTF-8",
          origin: base,
        },
        body: "encoded-flight-body",
      });
      return {
        status: res.status,
        hasNotFoundHeader: res.headers.get("x-nextjs-action-not-found") === "1",
      };
    }, BASE);

    expect(response.status).toBe(404);
    expect(response.hasNotFoundHeader).toBe(true);
  });
});
