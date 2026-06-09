// Regression test for issue #1466 ported from the Next.js deploy suite:
// .nextjs-ref/test/e2e/app-dir/use-params/use-params.test.ts (`should work on
// pages router` case).
//
// In a project that has BOTH `app/` and `pages/` directories, a Pages Router
// dynamic page using `useParams()` from `next/navigation` must return the
// dynamic route params after hydration. The Next.js test asserts:
//
//   expect(await browser.elementById('params').text()).toBe('"foobar"')
//
// `elementById` waits for the element to become visible; an empty `<div>`
// (which is what we render when `params?.dynamic` is undefined) has zero
// height and is therefore not visible, so the failure mode in the deploy
// suite is a Playwright visibility timeout.
//
// Fixture: tests/fixtures/app-basic/pages/pages-dir-use-params/[dynamic]/index.tsx
import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("issue #1466: Pages Router useParams under app+pages project", () => {
  test("renders dynamic param JSON after hydration", async ({ page }) => {
    await page.goto(`${BASE}/pages-dir-use-params/foobar`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toBeVisible();
    await expect(page.locator("#params")).toHaveText('"foobar"');
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  test("keeps the pages-router params object stable across rerenders", async ({ page }) => {
    const paramsChangeLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("params changed")) {
        paramsChangeLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/search-params-pages/foo`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toHaveText('{"foo":"foo"}');
    await expect(page.locator("#params-change-count")).toHaveText("2");
    await expect.poll(() => paramsChangeLogs.length).toBe(2);
    const initialChangeCount = await page.locator("#params-change-count").textContent();
    const initialLogCount = paramsChangeLogs.length;

    await page.click("#rerender-button");
    await page.click("#rerender-button");
    await page.click("#rerender-button");

    await expect(page.locator("#rerender-button")).toHaveText("Re-Render 3");
    await expect(page.locator("#params-change-count")).toHaveText(initialChangeCount ?? "");
    expect(paramsChangeLogs).toHaveLength(initialLogCount);

    await page.click("#change-params-button");
    await expect(page).toHaveURL(`${BASE}/search-params-pages/bar`);
    await expect(page.locator("#params")).toHaveText('{"foo":"bar"}');
    await expect.poll(() => paramsChangeLogs.length).toBe(initialLogCount + 1);
  });

  test("defers initial pages-router query snapshots until router readiness", async ({ page }) => {
    const searchParamsChangeLogs: string[] = [];
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("search params changed")) {
        searchParamsChangeLogs.push(text);
      }
      if (text.includes("Hydration failed") || text.includes("server rendered text didn't match")) {
        hydrationErrors.push(text);
      }
    });
    page.on("pageerror", (error) => {
      const message = error.message;
      if (
        message.includes("Hydration failed") ||
        message.includes("server rendered text didn't match")
      ) {
        hydrationErrors.push(message);
      }
    });

    const response = await page.request.get(`${BASE}/search-params-pages/foo?x=1`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('<output id="pathname-direct">null</output>');

    await page.goto(`${BASE}/search-params-pages/foo?x=1`);
    await waitForHydration(page);

    await expect(page.locator("#pages-router-ready")).toHaveText("true");
    await expect(page.locator("#pathname-direct")).toHaveText('"/search-params-pages/foo"');
    await expect(page.locator("#search-params-direct")).toHaveText("x=1");
    await expect(page.locator("#search-params")).toHaveText("x=1");
    await expect(page.locator("#search-params-snapshots")).toHaveText('["","x=1"]');
    await expect(page.locator("#search-params-change-count")).toHaveText("2");
    await expect
      .poll(() => searchParamsChangeLogs)
      .toEqual(["search params changed ", "search params changed x=1"]);
    expect(hydrationErrors).toEqual([]);

    await page.click("#rerender-button");
    await page.click("#rerender-button");
    await page.click("#rerender-button");

    await expect(page.locator("#rerender-button")).toHaveText("Re-Render 3");
    await expect(page.locator("#search-params-direct")).toHaveText("x=1");
    await expect(page.locator("#search-params")).toHaveText("x=1");
    await expect(page.locator("#search-params-snapshots")).toHaveText('["","x=1"]');
    await expect(page.locator("#search-params-change-count")).toHaveText("2");
    expect(searchParamsChangeLogs).toEqual(["search params changed ", "search params changed x=1"]);
    expect(hydrationErrors).toEqual([]);
  });

  test("keeps rewrite-driven pre-ready static pages snapshots consistent through hydration", async ({
    page,
  }) => {
    const hydrationErrors: string[] = [];
    const paramsChangeLogs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("static rewrites params changed")) {
        paramsChangeLogs.push(text);
      }
      if (text.includes("Hydration failed") || text.includes("server rendered text didn't match")) {
        hydrationErrors.push(text);
      }
    });
    page.on("pageerror", (error) => {
      const message = error.message;
      if (
        message.includes("Hydration failed") ||
        message.includes("server rendered text didn't match")
      ) {
        hydrationErrors.push(message);
      }
    });

    const response = await page.request.get(`${BASE}/search-params-static-rewrites`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('<output id="params-direct">null</output>');
    expect(html).toContain(
      '<output id="pathname-direct">&quot;/search-params-static-rewrites&quot;</output>',
    );
    expect(html).toContain('<output id="search-params-direct"></output>');

    await page.goto(`${BASE}/search-params-static-rewrites`);
    await waitForHydration(page);

    await expect(page.locator("#pages-router-ready")).toHaveText("true");
    await expect(page.locator("#params-direct")).toHaveText("{}");
    await expect(page.locator("#pathname-direct")).toHaveText('"/search-params-static-rewrites"');
    await expect(page.locator("#params-snapshots")).toHaveText('["null","{}"]');
    await expect(page.locator("#search-params-direct")).toHaveText("");
    await expect(page.locator("#search-params-snapshots")).toHaveText('[""]');
    await expect
      .poll(() => paramsChangeLogs)
      .toEqual(["static rewrites params changed null", "static rewrites params changed {}"]);
    expect(hydrationErrors).toEqual([]);
  });
});
