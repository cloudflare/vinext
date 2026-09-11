import { test, expect } from "../fixtures";

// The Pages Router dev overlay uses the same installer as the App Router, so an
// attribute-only hydration mismatch should surface identically as a "Console
// Error" once console.error is patched. This test intentionally triggers a
// console error, so it deliberately does NOT use the `consoleErrors` fixture.
// Ported from Next.js's hydration acceptance coverage:
// https://github.com/vercel/next.js/blob/canary/test/development/acceptance-app/hydration-error.test.ts
const BASE = "http://localhost:4173";

test.describe("Pages Router dev overlay", () => {
  test("attribute-only hydration mismatch surfaces as a Console Error", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(`${BASE}/dev-overlay-hydration`);
    await expect(page.getByTestId("dev-overlay-hydration-content")).toBeVisible();

    const dialog = page.getByTestId("vinext-dev-error-overlay");
    const indicator = page.getByTestId("vinext-dev-error-indicator");
    await expect(indicator.or(dialog).first()).toBeVisible({ timeout: 10_000 });
    if ((await indicator.count()) > 0 && (await dialog.count()) === 0) {
      await indicator.click();
    }
    await expect(dialog).toBeVisible({ timeout: 2_000 });

    await expect(page.getByTestId("vinext-dev-error-title")).toHaveText("Console Error");
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText("patched up");

    // React does not patch the mismatched attribute — the DOM keeps the server
    // value, proving the attribute (not recoverable) path.
    await expect(page.getByTestId("hydration-attribute-target")).toHaveAttribute(
      "aria-label",
      "auto",
    );

    // Exactly one overlay entry.
    await expect(page.getByTestId("vinext-dev-error-pagination")).toBeHidden();

    // The browser console still received the original warning.
    expect(consoleErrors.some((text) => text.includes("patched up"))).toBe(true);
  });
});
