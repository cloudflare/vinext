import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/script", () => {
  test("hoists page beforeInteractive scripts ahead of document and Vite scripts", async ({
    page,
    request,
  }) => {
    const rawHtml = await request
      .get(`${BASE}/script-page-before`)
      .then((response) => response.text());
    expect(rawHtml.indexOf('id="page-before"')).toBeLessThan(rawHtml.indexOf('name="description"'));

    await page.goto(`${BASE}/script-page-before`);
    await expect(page.getByRole("heading", { name: "Page Before Interactive" })).toBeVisible();

    const placement = await page.evaluate(() => {
      const pageScript = document.querySelector<HTMLScriptElement>("script#page-before");
      const documentScript = document.querySelector<HTMLScriptElement>("script#document-before");
      const viteScript = document.querySelector<HTMLScriptElement>('script[src="/@vite/client"]');
      const headScripts = Array.from(document.head.querySelectorAll("script"));

      return {
        pageInHead: pageScript?.parentElement === document.head,
        pageBeforeDocument:
          pageScript != null &&
          documentScript != null &&
          headScripts.indexOf(pageScript) < headScripts.indexOf(documentScript),
        documentBeforeVite:
          documentScript != null &&
          viteScript != null &&
          headScripts.indexOf(documentScript) < headScripts.indexOf(viteScript),
        bodyCopies: document.body.querySelectorAll("script#page-before").length,
      };
    });

    expect(placement).toEqual({
      pageInHead: true,
      pageBeforeDocument: true,
      documentBeforeVite: true,
      bodyCopies: 0,
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextPageBeforeExecutions")))
      .toBe(1);

    const toggle = page.getByRole("button", { name: "Toggle page script" });
    await toggle.click();
    await toggle.click();

    await expect(page.locator("script#page-before")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextPageBeforeExecutions")))
      .toBe(1);
  });

  // Ported from Next.js: packages/next/src/client/script.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/script.tsx
  // Next.js retains ScriptCache entries after remote scripts load, so a script
  // emitted by _document is not reloaded by page components with different ids.
  test("deduplicates loaded same-src scripts across different ids", async ({ page }) => {
    await page.goto(`${BASE}/script-dedupe`);
    await expect(page.getByRole("heading", { name: "Script Dedupe" })).toBeVisible();

    await expect.poll(() => page.locator('script[src="/dedupe-script.js"]').count()).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextScriptDedupeExecutions")))
      .toBe(1);
  });

  test("fires onReady for hydrated and remounted beforeInteractive scripts", async ({ page }) => {
    await page.goto(`${BASE}/script-before-ready`);
    await expect(page.getByRole("heading", { name: "Before Interactive Ready" })).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextBeforeReadyCalls")))
      .toBe(1);

    const toggle = page.getByRole("button", { name: "Toggle script" });
    await toggle.click();
    await toggle.click();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextBeforeReadyCalls")))
      .toBe(2);
  });

  test("executes a beforeInteractive script introduced by client navigation", async ({ page }) => {
    await page.goto(`${BASE}/script-dedupe`);
    await page.getByRole("link", { name: "Navigate to script target" }).click();
    await expect(page.getByRole("heading", { name: "Script Navigation Target" })).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, "__vinextPagesNavigationBeforeExecutions")),
      )
      .toBe(1);
    await expect(page.locator('script[id="pages-navigation-before"]')).toHaveCount(1);
  });
});
