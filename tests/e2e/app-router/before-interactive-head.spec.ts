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

  test("fires onReady for hydrated and remounted hoisted scripts without re-executing", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/beforeinteractive-ready`);
    await expect(page.getByRole("heading", { name: "App Before Interactive Ready" })).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextAppBeforeReadyCalls")))
      .toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextAppBeforeScriptExecutions")))
      .toBe(1);
    await expect(page.locator('script[src="/beforeinteractive-ready.js"]')).toHaveCount(1);

    const toggle = page.getByRole("button", { name: "Toggle script" });
    await toggle.click();
    await toggle.click();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextAppBeforeReadyCalls")))
      .toBe(2);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextAppBeforeScriptExecutions")))
      .toBe(1);
    await expect(page.locator('script[src="/beforeinteractive-ready.js"]')).toHaveCount(1);

    void consoleErrors;
  });

  test("hydrates a late Suspense script without suppressing or duplicating it", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.addEventListener("unhandledrejection", () => {
        Reflect.set(
          window,
          "__vinextUnhandledRejectionCalls",
          (Reflect.get(window, "__vinextUnhandledRejectionCalls") ?? 0) + 1,
        );
      });
      const appendChild = Object.getOwnPropertyDescriptor(Node.prototype, "appendChild")?.value as (
        this: Node,
        node: Node,
      ) => Node;
      Node.prototype.appendChild = function <T extends Node>(node: T): T {
        if (
          node instanceof HTMLScriptElement &&
          node.src.endsWith("/beforeinteractive-late-failed.js")
        ) {
          const appended = appendChild.call(this, node) as T;
          queueMicrotask(() => node.dispatchEvent(new Event("error")));
          return appended;
        }
        return appendChild.call(this, node) as T;
      };
    });
    await page.goto(`${BASE}/beforeinteractive-late-suspense`);
    await expect(
      page.getByRole("heading", { name: "Late Before Interactive Suspense" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle late script" })).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextLateBeforeErrorCalls")))
      .toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, "__vinextLateFailedReadyCalls"))).toBe(
      undefined,
    );
    expect(await page.evaluate(() => Reflect.get(window, "__vinextUnhandledRejectionCalls"))).toBe(
      undefined,
    );

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextLateBeforeScriptExecutions")))
      .toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextLateBeforeReadyCalls")))
      .toBe(1);
    expect(
      await page.evaluate(() => Reflect.get(window, "__vinextLateBeforeReadyFiredEarly")),
    ).not.toBe(true);
    await expect(page.locator('script[id="app-late-before-ready"]')).toHaveCount(1);

    const toggle = page.getByRole("button", { name: "Toggle late script" });
    await toggle.click();
    await toggle.click();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextLateBeforeReadyCalls")))
      .toBe(2);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextLateBeforeScriptExecutions")))
      .toBe(1);
    await expect(page.locator('script[id="app-late-before-ready"]')).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });
});
