import { test, expect } from "../fixtures";

const BASE = "http://localhost:4174";

test.describe("inline beforeInteractive head ordering", () => {
  test("inline beforeInteractive script runs before stylesheets and hydration completes without console errors", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/beforeinteractive-head-ordering`);

    // The hoisted script writes a marker on `self` before any stylesheet or
    // modulepreload runs. The fixture stores the flag on a global (not a
    // `<html>` dataset attribute) so the assertion survives React Float's
    // head reconciliation without `suppressHydrationWarning` on the shared
    // root layout.
    const themeInitRan = await page.evaluate(
      () => (self as unknown as { __vinextThemeInitRan?: boolean }).__vinextThemeInitRan,
    );
    expect(themeInitRan).toBe(true);

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

  test("markup in inline beforeInteractive data stays inside the script", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/beforeinteractive-script-data`);

    // The fixture's data holds `<!--<script>`, `</head>` and `</body></html>`.
    // Each one used to split the hoisted script: the data after it became
    // document markup and the script threw a SyntaxError.
    const scriptData = await page.evaluate(
      () => (self as unknown as { __vinextScriptData?: unknown }).__vinextScriptData,
    );
    expect(scriptData).toEqual({
      name: "<!--<script>",
      bio: '</head><p id="profile-bio">bio</p></body></html>',
    });
    await expect(page.locator("#profile-bio")).toHaveCount(0);
    await expect(page.locator("#script-data-heading")).toHaveText("beforeInteractive script data");
    await expect(page.locator("main")).toHaveCount(1);

    // The loader swapped itself for the real script element, which keeps the
    // author's body verbatim and sits first in <head>.
    const script = await page.evaluate(() => {
      const element = document.getElementById("vinext-test-script-data");
      return {
        parent: element?.parentElement?.tagName,
        isFirstHeadScript: document.head.querySelector("script") === element,
        text: element?.textContent,
        marker: element?.getAttribute("data-nscript"),
      };
    });
    expect(script).toEqual({
      parent: "HEAD",
      isFirstHeadScript: true,
      text: `self.__vinextScriptData = ${JSON.stringify({
        name: "<!--<script>",
        bio: '</head><p id="profile-bio">bio</p></body></html>',
      })};`,
      marker: "beforeInteractive",
    });

    void consoleErrors;
  });

  test("inline beforeInteractive script runs under a nonce-based CSP", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(
      `${BASE}/beforeinteractive-head-ordering?csp-nonce=before-interactive-nonce`,
    );
    expect(response?.headers()["content-security-policy"]).toBe(
      "script-src 'nonce-before-interactive-nonce' 'strict-dynamic';",
    );

    const themeInitRan = await page.evaluate(
      () => (self as unknown as { __vinextThemeInitRan?: boolean }).__vinextThemeInitRan,
    );
    expect(themeInitRan).toBe(true);
    // 'strict-dynamic' would also admit a created script without a nonce, so
    // check the nonce itself: a nonce-only policy needs it.
    const nonce = await page.evaluate(
      () => (document.getElementById("vinext-test-theme-init") as HTMLScriptElement | null)?.nonce,
    );
    expect(nonce).toBe("before-interactive-nonce");
    expect(consoleErrors.filter((message) => message.includes("Content Security Policy"))).toEqual(
      [],
    );
  });
});
