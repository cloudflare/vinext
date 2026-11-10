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
    test(`queued beforeInteractive scripts run in order${name}`, async ({
      page,
      consoleErrors,
    }) => {
      const response = await expectQueuedScriptsRunInOrder(page, search);
      expect(response?.headers()["content-security-policy"]).toBe(csp);
      expect(
        consoleErrors.filter((message) => message.includes("Content Security Policy")),
      ).toEqual([]);
    });
  }

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

// Loads the fixture with its deferred classic script held back, so the module
// after it is ready first, and the second inline module's import held back
// longer still. The queued scripts must run in order, with hydration waiting
// for the external ones but not for the inline module's import.
async function expectQueuedScriptsRunInOrder(page: Page, search: string): Promise<Response | null> {
  await page.route("**/before-interactive-deferred.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await page.route("**/before-interactive-module-import.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  const response = await page.goto(`${BASE}/beforeinteractive-script-data${search}`);
  await waitForAppRouterHydration(page);

  const readLog = () =>
    page.evaluate(
      () =>
        (self as unknown as { __vinextModuleLog?: { name: string; hydrated: boolean }[] })
          .__vinextModuleLog ?? [],
    );
  await expect.poll(async () => (await readLog()).length).toBe(5);
  const log = await readLog();
  expect(log.map((entry) => entry.name)).toEqual([
    "deferred-classic",
    "external-module",
    "module-1",
    "module-2-import",
    "module-2",
  ]);
  expect(log.filter((entry) => entry.hydrated).map((entry) => entry.name)).toEqual([
    "module-2-import",
    "module-2",
  ]);

  const scripts = await page.evaluate(() =>
    [
      "vinext-test-deferred-classic",
      "vinext-test-external-module",
      "vinext-test-module-1",
      "vinext-test-module-2",
    ].map((id) => {
      const element = document.getElementById(id) as HTMLScriptElement | null;
      return {
        parent: element?.parentElement?.tagName,
        type: element?.type,
        async: element?.async,
        marker: element?.getAttribute("data-nscript"),
      };
    }),
  );
  const expected = { parent: "HEAD", async: false, marker: "beforeInteractive" };
  expect(scripts).toEqual([
    { ...expected, type: "" },
    { ...expected, type: "module" },
    { ...expected, type: "module" },
    { ...expected, type: "module" },
  ]);
  return response;
}
