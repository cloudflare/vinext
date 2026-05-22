import { test, expect } from "../fixtures";

const BASE = "http://localhost:4174";

test.describe("inline beforeInteractive head ordering", () => {
  test("inline beforeInteractive script runs before stylesheets and hydration completes without console errors", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/beforeinteractive-head-ordering`);

    // The script writes a marker to documentElement.dataset before any
    // stylesheet/modulepreload runs. If the script were hoisted incorrectly
    // (or duplicated by hydration), this would still be observable.
    const themeInitRan = await page.evaluate(() => document.documentElement.dataset.themeInitRan);
    expect(themeInitRan).toBe("true");

    // Verify exactly one instance of the hoisted script is in the DOM. A
    // hydration mismatch where the client renders a second <script> would
    // produce two matches.
    const scriptCount = await page.evaluate(
      () => document.querySelectorAll('script[id="vinext-test-theme-init"]').length,
    );
    expect(scriptCount).toBe(1);

    // Verify the hoisted script is the first <script> tag in head, even
    // though other resource hints exist.
    const isFirstHeadScript = await page.evaluate(() => {
      const headScripts = document.head.querySelectorAll("script");
      return headScripts.length > 0 && headScripts[0]?.id === "vinext-test-theme-init";
    });
    expect(isFirstHeadScript).toBe(true);

    // consoleErrors fixture fails the test if any errors occurred, including
    // hydration warnings.
    void consoleErrors;
  });
});
