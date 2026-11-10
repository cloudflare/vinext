import type { Page, Response } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForAppRouterHydration } from "../helpers";

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

  for (const { name, search, csp } of [
    { name: "", search: "", csp: undefined },
    {
      name: " under a nonce-based CSP",
      search: "?csp-nonce=before-interactive-nonce",
      csp: "script-src 'nonce-before-interactive-nonce' 'strict-dynamic';",
    },
    {
      name: " under a same-origin and inline CSP",
      search: "?csp-self",
      csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval';",
    },
  ]) {
    test(`beforeInteractive module scripts run in order before hydration${name}`, async ({
      page,
      consoleErrors,
    }) => {
      const response = await expectModulesRunInOrderBeforeHydration(page, search);
      expect(response?.headers()["content-security-policy"]).toBe(csp);
      expect(
        consoleErrors.filter((message) => message.includes("Content Security Policy")),
      ).toEqual([]);
    });
  }

  // A report-only policy reports every script here but blocks none, so the
  // modules must still hold hydration back. Its reports are console errors,
  // so this test does not use the consoleErrors fixture.
  test("beforeInteractive module scripts run in order before hydration under a report-only CSP", async ({
    page,
  }) => {
    const response = await expectModulesRunInOrderBeforeHydration(page, "?csp-report-only");
    expect(response?.headers()["content-security-policy-report-only"]).toBe("script-src 'none';");
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

// Loads the module fixture with its external module held back, so the inline
// modules after it and the bootstrap are both ready first, and the second
// inline module's import held back longer still. All three modules must still
// run in order before hydration.
async function expectModulesRunInOrderBeforeHydration(
  page: Page,
  search: string,
): Promise<Response | null> {
  await page.route("**/before-interactive-module.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await page.route("**/before-interactive-module-import.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  const response = await page.goto(`${BASE}/beforeinteractive-script-data${search}`);
  await waitForAppRouterHydration(page);

  const moduleLog = await page.evaluate(
    () => (self as unknown as { __vinextModuleLog?: unknown }).__vinextModuleLog,
  );
  expect(moduleLog).toEqual([
    { name: "external-module", hydrated: false },
    { name: "module-1", hydrated: false },
    { name: "module-2-import", hydrated: false },
    { name: "module-2", hydrated: false },
  ]);

  const modules = await page.evaluate(() =>
    ["vinext-test-external-module", "vinext-test-module-1", "vinext-test-module-2"].map((id) => {
      const element = document.getElementById(id) as HTMLScriptElement | null;
      return {
        parent: element?.parentElement?.tagName,
        type: element?.type,
        async: element?.async,
        marker: element?.getAttribute("data-nscript"),
      };
    }),
  );
  const expected = { parent: "HEAD", type: "module", async: false, marker: "beforeInteractive" };
  expect(modules).toEqual([expected, expected, expected]);
  // The sentinels queued after the inline modules removed themselves.
  expect(
    await page.evaluate(
      () => document.querySelectorAll('script[type="module"]:not([src]):not([id])').length,
    ),
  ).toBe(0);
  return response;
}
