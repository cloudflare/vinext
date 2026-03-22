import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

async function waitForProvidersList(page: import("@playwright/test").Page) {
  await expect(page.locator("#providers-title")).toHaveText("Providers");
  await expect(page.locator("#provider-list")).toBeVisible({ timeout: 10_000 });
}

async function installNavigationProbe(page: import("@playwright/test").Page, name: string) {
  await page.evaluate((probeName) => {
    const events: Array<Record<string, unknown>> = [];
    const win = window as typeof window & {
      __vinextNavProbe__?: Record<string, Array<Record<string, unknown>>>;
      __vinextOriginalScrollTo__?: typeof window.scrollTo;
    };

    const record = (type: string) => {
      events.push({
        type,
        t: performance.now(),
        path: location.pathname,
        scrollY: window.scrollY,
        loadingVisible: !!document.querySelector("#providers-loading"),
        listVisible: !!document.querySelector("#provider-list"),
        heading: document.querySelector("h1")?.textContent ?? null,
      });
    };

    if (!win.__vinextNavProbe__) {
      win.__vinextNavProbe__ = {};
    }
    win.__vinextNavProbe__[probeName] = events;

    if (!win.__vinextOriginalScrollTo__) {
      win.__vinextOriginalScrollTo__ = window.scrollTo.bind(window);
      window.scrollTo = ((optionsOrX?: ScrollToOptions | number, y?: number) => {
        record("scrollTo");
        if (typeof optionsOrX === "number") {
          return win.__vinextOriginalScrollTo__!(optionsOrX, y ?? 0);
        }
        return win.__vinextOriginalScrollTo__!(optionsOrX);
      }) as typeof window.scrollTo;
    }

    const observer = new MutationObserver(() => {
      const last = events[events.length - 1];
      const loadingVisible = !!document.querySelector("#providers-loading");
      const listVisible = !!document.querySelector("#provider-list");
      const heading = document.querySelector("h1")?.textContent ?? null;

      if (
        !last ||
        last.loadingVisible !== loadingVisible ||
        last.listVisible !== listVisible ||
        last.heading !== heading
      ) {
        record("mutation");
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    record("start");
  }, name);
}

async function readProbe(page: import("@playwright/test").Page, name: string) {
  return page.evaluate((probeName) => {
    return (
      (
        window as typeof window & {
          __vinextNavProbe__?: Record<string, Array<Record<string, unknown>>>;
        }
      ).__vinextNavProbe__?.[probeName] ?? []
    );
  }, name) as Promise<
    Array<{
      type: string;
      t: number;
      path: string;
      scrollY: number;
      loadingVisible: boolean;
      listVisible: boolean;
      heading: string | null;
    }>
  >;
}

test.describe("App Router navigation regressions", () => {
  test("returning to the providers list via Link does not flash the loading fallback", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    await page.locator("#nav-flash-link").click();
    await waitForProvidersList(page);

    await page.locator("#provider-link").click();
    await expect(page.locator("#provider-title")).toHaveText("Provider: acme");

    await installNavigationProbe(page, "link-return");
    await page.locator("#back-to-providers").click();
    await waitForProvidersList(page);

    const events = await readProbe(page, "link-return");

    expect(events.some((event) => event.loadingVisible)).toBe(false);
  });

  test("browser back restores scroll only after the providers list is visible", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    await page.locator("#nav-flash-link").click();
    await waitForProvidersList(page);

    await page.locator("#provider-link").scrollIntoViewIfNeeded();
    const initialScroll = await page.evaluate(() => {
      window.scrollTo(
        0,
        document.querySelector("#provider-link")!.getBoundingClientRect().top + window.scrollY,
      );
      return window.scrollY;
    });

    await page.locator("#provider-link").click();
    await expect(page.locator("#provider-title")).toHaveText("Provider: acme");

    await installNavigationProbe(page, "popstate-return");
    await page.goBack();
    await waitForProvidersList(page);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);

    const events = await readProbe(page, "popstate-return");
    const scrollEvents = events.filter((event) => event.type === "scrollTo");

    expect(scrollEvents.length).toBeGreaterThan(0);
    expect(scrollEvents.every((event) => event.listVisible && !event.loadingVisible)).toBe(true);

    const restoredScroll = await page.evaluate(() => window.scrollY);
    expect(restoredScroll).toBeGreaterThan(0);
    expect(Math.abs(restoredScroll - initialScroll)).toBeLessThan(5);
  });
});
