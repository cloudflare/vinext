import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

// React's server renderer drops every attribute name longer than two
// characters that starts with "on" in any case. HTML attribute names are
// case-insensitive, so `ONERROR` on a <Head> child would otherwise become a
// working inline handler after parsing.
async function recordHeadAssetErrors(page: Page) {
  await page.addInitScript(() => {
    const errored: string[] = [];
    Reflect.set(window, "__headAssetErrors", errored);
    // Capture-phase listeners run before the target's inline handler in the
    // same dispatch, so once an asset is recorded here its handler (if any)
    // has already run by the time the test reads the flag.
    document.addEventListener(
      "error",
      (event) => {
        const target = event.target;
        if (target instanceof HTMLLinkElement) errored.push(target.getAttribute("href") ?? "");
        if (target instanceof HTMLScriptElement) errored.push(target.getAttribute("src") ?? "");
      },
      true,
    );
  });
}

function getHeadAssetErrors(page: Page) {
  return page.evaluate(() => {
    const value = Reflect.get(window, "__headAssetErrors");
    return Array.isArray(value) ? value.map(String) : [];
  });
}

function getHandlerFlag(page: Page) {
  return page.evaluate(() => Reflect.get(window, "__headEventHandlerRan") ?? null);
}

test.describe("next/head event handler attributes", () => {
  test("drops mixed-case on* attributes from SSR head tags", async ({ page }) => {
    await recordHeadAssetErrors(page);
    const response = await page.goto(`${BASE}/head-event-handler-attrs`);
    const html = (await response?.text()) ?? "";

    expect(html).toContain('href="/head-event-handler-missing.css"');
    expect(html).toContain('name="head-event-handler"');
    expect(html).not.toMatch(/\son(error|load)=/i);

    await expect.poll(() => getHeadAssetErrors(page)).toContain("/head-event-handler-missing.css");
    expect(await getHandlerFlag(page)).toBeNull();

    const link = page.locator('link[href="/head-event-handler-missing.css"]');
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute("onerror")).toBeNull();
    expect(await link.getAttribute("onload")).toBeNull();
    const meta = page.locator('meta[name="head-event-handler"]');
    expect(await meta.getAttribute("onerror")).toBeNull();
    expect(await meta.getAttribute("onload")).toBeNull();
  });

  test("drops mixed-case on* attributes from client-added head tags", async ({ page }) => {
    await recordHeadAssetErrors(page);
    await page.goto(`${BASE}/head-event-handler-attrs`);
    await waitForHydration(page);

    await page.getByRole("button", { name: "Add client head tags" }).click();

    const script = page.locator('script[src="/head-event-handler-missing.js"]');
    await expect(script).toHaveCount(1);
    await expect.poll(() => getHeadAssetErrors(page)).toContain("/head-event-handler-missing.js");
    expect(await getHandlerFlag(page)).toBeNull();
    expect(await script.getAttribute("onerror")).toBeNull();
    expect(await script.getAttribute("onload")).toBeNull();
  });
});
