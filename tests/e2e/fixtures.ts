/**
 * Shared Playwright fixtures for all e2e tests.
 *
 * This file provides a custom `test` fixture that automatically fails
 * tests if any console errors occur during execution. This helps catch
 * React hydration mismatches, runtime errors, and other bugs early.
 */
import { test as base, expect } from "@playwright/test";

/**
 * Patterns to ignore in console error checking.
 * Some errors are expected or come from third-party code.
 */
const IGNORED_ERROR_PATTERNS = [
  // Vite HMR connection messages (not actual errors)
  /\[vite\] connected/,
  // React's development-only "Invalid hook call" warning when testing hooks
  // outside component context (expected in some test scenarios)
  /Invalid hook call.*mismatching versions/,
];

/**
 * Check if an error message should be ignored.
 */
function shouldIgnoreError(message: string): boolean {
  return IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Extended test fixture that collects console errors and fails if any occur.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];

    // Collect console errors
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!shouldIgnoreError(text)) {
          errors.push(text);
        }
      }
    });

    // Collect uncaught page errors
    page.on("pageerror", (error) => {
      const text = error.message || String(error);
      if (!shouldIgnoreError(text)) {
        errors.push(`[PageError] ${text}`);
      }
    });

    // Run the test
    await use(errors);

    // After the test, fail if there were any console errors
    if (errors.length > 0) {
      const errorList = errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n");
      throw new Error(`Test failed due to ${errors.length} console error(s):\n${errorList}`);
    }
  },
});

export { expect };
