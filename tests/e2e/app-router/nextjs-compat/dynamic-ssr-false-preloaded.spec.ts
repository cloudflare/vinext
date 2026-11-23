/**
 * next/dynamic with ssr: false, after a client navigation, when the
 * component's module was already loaded before the click. Next.js renders the
 * component in the navigation's own commit; it should not wait for React's
 * 300 ms Suspense fallback throttle. The fixture's loader caches its import()
 * promise, so the module is settled before the click.
 */
import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test("preloaded ssr:false component commits with the page after a client navigation", async ({
  page,
}) => {
  await page.goto(`${BASE}/nextjs-compat/dynamic/ssr-false-preloaded`);
  await waitForAppRouterHydration(page);

  // Load the widget's module before the click, then let it settle.
  await page.hover("#ssr-false-preloaded-link");
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const w = window as unknown as { __times: Record<string, number> };
    w.__times = {};
    new MutationObserver(() => {
      for (const id of ["ssr-false-preloaded-heading", "ssr-false-preloaded-marker"]) {
        if (w.__times[id] === undefined && document.getElementById(id)) {
          w.__times[id] = performance.now();
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.click("#ssr-false-preloaded-link");
  await expect(page.locator("#ssr-false-preloaded-marker")).toHaveText("widget");

  const times = await page.evaluate(
    () => (window as unknown as { __times: Record<string, number> }).__times,
  );
  const gap = times["ssr-false-preloaded-marker"] - times["ssr-false-preloaded-heading"];
  console.log(`page -> marker gap: ${gap.toFixed(1)} ms`);
  // Next.js commits both together. Allow a wide margin under React's 300 ms throttle.
  expect(gap).toBeLessThan(150);
});
