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
  test("client route params stay in sync with the committed tree during cold dynamic navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-flash/param-sync/alpha`);
    await waitForHydration(page);
    await expect(page.locator("#client-param-label")).toHaveText("Client param: alpha");
    await expect(page.locator("#param-filter-title")).toHaveText("Server param: alpha");
    await expect(page.locator("#param-filter-first-row")).toHaveText("Alpha 1");

    await page.evaluate(() => {
      let active = true;
      const events: Array<{
        clientParam: string | null;
        serverParam: string | null;
        firstRow: string | null;
        pathname: string;
      }> = [];

      const capture = () => {
        events.push({
          clientParam: document.querySelector("#client-param-label")?.textContent ?? null,
          serverParam: document.querySelector("#param-filter-title")?.textContent ?? null,
          firstRow: document.querySelector("#param-filter-first-row")?.textContent ?? null,
          pathname: window.location.pathname,
        });
      };

      capture();
      const sample = () => {
        if (!active) return;
        capture();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      (
        window as typeof window & {
          __vinextParamSyncProbe__?: typeof events;
          __stopVinextParamSyncProbe__?: () => void;
        }
      ).__vinextParamSyncProbe__ = events;
      (
        window as typeof window & {
          __vinextParamSyncProbe__?: typeof events;
          __stopVinextParamSyncProbe__?: () => void;
        }
      ).__stopVinextParamSyncProbe__ = () => {
        active = false;
      };
    });

    await page.locator("#param-filter-beta").click();
    await expect(page.locator("#client-param-label")).toHaveText("Client param: beta");
    await expect(page.locator("#param-filter-title")).toHaveText("Server param: beta");
    await expect(page.locator("#param-filter-first-row")).toHaveText("Beta 1");
    await page.waitForTimeout(100);

    const events = await page.evaluate(() => {
      (
        window as typeof window & {
          __stopVinextParamSyncProbe__?: () => void;
          __vinextParamSyncProbe__?: Array<{
            clientParam: string | null;
            serverParam: string | null;
            firstRow: string | null;
            pathname: string;
          }>;
        }
      ).__stopVinextParamSyncProbe__?.();

      return (
        (
          window as typeof window & {
            __vinextParamSyncProbe__?: Array<{
              clientParam: string | null;
              serverParam: string | null;
              firstRow: string | null;
              pathname: string;
            }>;
          }
        ).__vinextParamSyncProbe__ ?? []
      );
    });

    expect(
      events.some(
        (event) =>
          event.clientParam === "Client param: beta" &&
          (event.serverParam !== "Server param: beta" || event.firstRow !== "Beta 1"),
      ),
    ).toBe(false);
  });

  test("client URL hooks stay in sync with the committed tree during cold filter navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-flash/query-sync`);
    await waitForHydration(page);
    await expect(page.locator("#client-filter-label")).toHaveText("Client filter: alpha");
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: alpha");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Alpha 1");

    await page.evaluate(() => {
      let active = true;
      const events: Array<{
        clientFilter: string | null;
        serverFilter: string | null;
        firstRow: string | null;
        search: string;
      }> = [];

      const capture = () => {
        events.push({
          clientFilter: document.querySelector("#client-filter-label")?.textContent ?? null,
          serverFilter: document.querySelector("#query-filter-title")?.textContent ?? null,
          firstRow: document.querySelector("#query-filter-first-row")?.textContent ?? null,
          search: window.location.search,
        });
      };

      capture();
      const sample = () => {
        if (!active) return;
        capture();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      (
        window as typeof window & {
          __vinextQuerySyncProbe__?: typeof events;
          __stopVinextQuerySyncProbe__?: () => void;
        }
      ).__vinextQuerySyncProbe__ = events;
      (
        window as typeof window & {
          __vinextQuerySyncProbe__?: typeof events;
          __stopVinextQuerySyncProbe__?: () => void;
        }
      ).__stopVinextQuerySyncProbe__ = () => {
        active = false;
      };
    });

    await page.locator("#query-filter-beta").click();
    const paintedFrames: Array<{
      clientFilter: string | null;
      serverFilter: string | null;
      firstRow: string | null;
      search: string;
    }> = [];
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(16);
      paintedFrames.push(
        await page.evaluate(() => ({
          clientFilter: document.querySelector("#client-filter-label")?.textContent ?? null,
          serverFilter: document.querySelector("#query-filter-title")?.textContent ?? null,
          firstRow: document.querySelector("#query-filter-first-row")?.textContent ?? null,
          search: window.location.search,
        })),
      );
    }
    await expect(page.locator("#client-filter-label")).toHaveText("Client filter: beta");
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: beta");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Beta 1");
    await page.waitForTimeout(100);

    const events = await page.evaluate(() => {
      (
        window as typeof window & {
          __stopVinextQuerySyncProbe__?: () => void;
          __vinextQuerySyncProbe__?: Array<{
            clientFilter: string | null;
            serverFilter: string | null;
            firstRow: string | null;
            search: string;
          }>;
        }
      ).__stopVinextQuerySyncProbe__?.();

      return (
        (
          window as typeof window & {
            __vinextQuerySyncProbe__?: Array<{
              clientFilter: string | null;
              serverFilter: string | null;
              firstRow: string | null;
              search: string;
            }>;
          }
        ).__vinextQuerySyncProbe__ ?? []
      );
    });

    expect(
      events.some(
        (event) =>
          event.clientFilter === "Client filter: beta" &&
          (event.serverFilter !== "Server filter: beta" || event.firstRow !== "Beta 1"),
      ),
    ).toBe(false);
    expect(
      paintedFrames.some(
        (event) =>
          event.serverFilter === "Server filter: beta" &&
          (event.clientFilter !== "Client filter: beta" ||
            event.firstRow !== "Beta 1" ||
            event.search !== "?filter=beta"),
      ),
    ).toBe(false);
  });

  test("cold filter navigation does not reveal the destination shell before its list is ready", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-flash/query-sync`);
    await waitForHydration(page);
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: alpha");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Alpha 1");

    await page.evaluate(() => {
      let active = true;
      const events: Array<{
        heading: string | null;
        loadingVisible: boolean;
        firstRow: string | null;
      }> = [];

      const capture = () => {
        events.push({
          heading: document.querySelector("#query-filter-title")?.textContent ?? null,
          loadingVisible: !!document.querySelector("#query-filter-loading"),
          firstRow: document.querySelector("#query-filter-first-row")?.textContent ?? null,
        });
      };

      capture();
      const sample = () => {
        if (!active) return;
        capture();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      (
        window as typeof window & {
          __vinextColdShellProbe__?: typeof events;
          __stopVinextColdShellProbe__?: () => void;
        }
      ).__vinextColdShellProbe__ = events;
      (
        window as typeof window & {
          __vinextColdShellProbe__?: typeof events;
          __stopVinextColdShellProbe__?: () => void;
        }
      ).__stopVinextColdShellProbe__ = () => {
        active = false;
      };
    });

    await page.locator("#query-filter-beta").click();
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: beta");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Beta 1");
    await page.waitForTimeout(100);

    const events = await page.evaluate(() => {
      (
        window as typeof window & {
          __stopVinextColdShellProbe__?: () => void;
          __vinextColdShellProbe__?: Array<{
            heading: string | null;
            loadingVisible: boolean;
            firstRow: string | null;
          }>;
        }
      ).__stopVinextColdShellProbe__?.();

      return (
        (
          window as typeof window & {
            __vinextColdShellProbe__?: Array<{
              heading: string | null;
              loadingVisible: boolean;
              firstRow: string | null;
            }>;
          }
        ).__vinextColdShellProbe__ ?? []
      );
    });

    expect(
      events.some(
        (event) =>
          event.heading === "Server filter: beta" &&
          (event.loadingVisible || event.firstRow !== "Beta 1"),
      ),
    ).toBe(false);
  });

  test("fresh filter navigation suppresses mount-time row animations on the first visible frame", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-flash/query-sync`);
    await waitForHydration(page);
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: alpha");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Alpha 1");

    await page.evaluate(() => {
      let active = true;
      const events: Array<{
        heading: string | null;
        firstRow: string | null;
        firstRowOpacity: string | null;
        firstRowAnimation: string | null;
      }> = [];

      const capture = () => {
        const firstRow = document.querySelector("#query-filter-first-row");
        const style = firstRow ? getComputedStyle(firstRow) : null;
        events.push({
          heading: document.querySelector("#query-filter-title")?.textContent ?? null,
          firstRow: firstRow?.textContent ?? null,
          firstRowOpacity: style?.opacity ?? null,
          firstRowAnimation: style?.animationName ?? null,
        });
      };

      capture();
      const sample = () => {
        if (!active) return;
        capture();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      (
        window as typeof window & {
          __vinextAnimationProbe__?: typeof events;
          __stopVinextAnimationProbe__?: () => void;
        }
      ).__vinextAnimationProbe__ = events;
      (
        window as typeof window & {
          __vinextAnimationProbe__?: typeof events;
          __stopVinextAnimationProbe__?: () => void;
        }
      ).__stopVinextAnimationProbe__ = () => {
        active = false;
      };
    });

    await page.locator("#query-filter-beta").click();
    await expect(page.locator("#query-filter-title")).toHaveText("Server filter: beta");
    await expect(page.locator("#query-filter-first-row")).toHaveText("Beta 1");
    await page.waitForTimeout(100);

    const events = await page.evaluate(() => {
      (
        window as typeof window & {
          __stopVinextAnimationProbe__?: () => void;
          __vinextAnimationProbe__?: Array<{
            heading: string | null;
            firstRow: string | null;
            firstRowOpacity: string | null;
            firstRowAnimation: string | null;
          }>;
        }
      ).__stopVinextAnimationProbe__?.();

      return (
        (
          window as typeof window & {
            __vinextAnimationProbe__?: Array<{
              heading: string | null;
              firstRow: string | null;
              firstRowOpacity: string | null;
              firstRowAnimation: string | null;
            }>;
          }
        ).__vinextAnimationProbe__ ?? []
      );
    });

    const firstDestinationFrame = events.find(
      (event) => event.heading === "Server filter: beta" && event.firstRow === "Beta 1",
    );

    expect(firstDestinationFrame).toBeTruthy();
    expect(firstDestinationFrame?.firstRowOpacity).toBe("1");
    expect(firstDestinationFrame?.firstRowAnimation).toBe("none");
  });

  test("cold Link navigation keeps client URL state aligned with the committed tree", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);
    await expect(page.locator("#link-client-filter-label")).toHaveText("Client filter: alpha");
    await expect(page.locator("#link-filter-title")).toHaveText("Server filter: alpha");
    await expect(page.locator("#link-filter-first-row")).toHaveText("Alpha 1");

    await page.evaluate(() => {
      let active = true;
      const events: Array<{
        clientFilter: string | null;
        serverFilter: string | null;
        firstRow: string | null;
        firstRowOpacity: string | null;
        firstRowAnimation: string | null;
        search: string;
      }> = [];

      const capture = () => {
        const firstRow = document.querySelector("#link-filter-first-row");
        const style = firstRow ? getComputedStyle(firstRow) : null;
        events.push({
          clientFilter: document.querySelector("#link-client-filter-label")?.textContent ?? null,
          serverFilter: document.querySelector("#link-filter-title")?.textContent ?? null,
          firstRow: firstRow?.textContent ?? null,
          firstRowOpacity: style?.opacity ?? null,
          firstRowAnimation: style?.animationName ?? null,
          search: window.location.search,
        });
      };

      capture();
      const sample = () => {
        if (!active) return;
        capture();
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      (
        window as typeof window & {
          __vinextLinkSyncProbe__?: typeof events;
          __stopVinextLinkSyncProbe__?: () => void;
        }
      ).__vinextLinkSyncProbe__ = events;
      (
        window as typeof window & {
          __vinextLinkSyncProbe__?: typeof events;
          __stopVinextLinkSyncProbe__?: () => void;
        }
      ).__stopVinextLinkSyncProbe__ = () => {
        active = false;
      };
    });

    await page.locator("#link-filter-beta").click();
    await expect(page.locator("#link-client-filter-label")).toHaveText("Client filter: beta");
    await expect(page.locator("#link-filter-title")).toHaveText("Server filter: beta");
    await expect(page.locator("#link-filter-first-row")).toHaveText("Beta 1");
    await page.waitForTimeout(100);

    const events = await page.evaluate(() => {
      (
        window as typeof window & {
          __stopVinextLinkSyncProbe__?: () => void;
          __vinextLinkSyncProbe__?: Array<{
            clientFilter: string | null;
            serverFilter: string | null;
            firstRow: string | null;
            firstRowOpacity: string | null;
            firstRowAnimation: string | null;
            search: string;
          }>;
        }
      ).__stopVinextLinkSyncProbe__?.();

      return (
        (
          window as typeof window & {
            __vinextLinkSyncProbe__?: Array<{
              clientFilter: string | null;
              serverFilter: string | null;
              firstRow: string | null;
              firstRowOpacity: string | null;
              firstRowAnimation: string | null;
              search: string;
            }>;
          }
        ).__vinextLinkSyncProbe__ ?? []
      );
    });

    expect(
      events.some(
        (event) =>
          event.clientFilter === "Client filter: beta" &&
          (event.serverFilter !== "Server filter: beta" || event.firstRow !== "Beta 1"),
      ),
    ).toBe(false);

    const firstDestinationFrame = events.find(
      (event) => event.serverFilter === "Server filter: beta" && event.firstRow === "Beta 1",
    );

    expect(firstDestinationFrame).toBeTruthy();
    expect(firstDestinationFrame?.firstRowOpacity).toBe("1");
    expect(firstDestinationFrame?.firstRowAnimation).toBe("none");
  });

  test("hover prefetch followed by immediate click navigates without blocking on the prefetch", async ({
    page,
  }) => {
    // Next.js's segment cache does not block navigation on pending prefetches.
    // If the prefetch hasn't settled by click time, a fresh dynamic request
    // fires. This prevents navigation from hanging when prefetch is slow
    // (e.g. Firefox with non-standard fetch options on Cloudflare Workers).
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);

    await page.locator("#link-filter-beta").hover();
    await page.waitForTimeout(50);

    await page.locator("#link-filter-beta").click();
    await expect(page.locator("#link-client-filter-label")).toHaveText("Client filter: beta");
    await expect(page.locator("#link-filter-title")).toHaveText("Server filter: beta");
    await expect(page.locator("#link-filter-first-row")).toHaveText("Beta 1");
  });

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
