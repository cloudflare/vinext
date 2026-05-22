/**
 * Pages Router i18n sticky-locale tests.
 *
 * Covers GitHub issue #1336 (item 2): "Locale detection re-runs on every
 * request instead of being sticky." This file focuses on the client-side
 * half — Link, Router.push/replace, history state shape, and popstate.
 *
 * Ported behaviours from Next.js:
 *   - test/e2e/i18n-preferred-locale-detection (locale carries through Link)
 *   - test/e2e/ignore-invalid-popstateevent (stale popstate ignored, locale
 *     in history state preserved across back/forward)
 *
 * The server-side companion (NEXT_LOCALE cookie write on detection) is
 * already partially in place via `parseCookieLocaleFromHeader` honouring
 * the cookie ahead of Accept-Language detection; setting the cookie on
 * initial detection is intentionally out of scope to avoid overlapping
 * with #1336 item 4 (default-locale prefix normalisation).
 */
import { describe, it, expect, vi } from "vite-plus/test";
import path from "node:path";
import { safeJsonStringify } from "../packages/vinext/src/server/html.js";
import { buildPagesNextDataScript } from "../packages/vinext/src/server/pages-page-response.js";

function createNavWindow() {
  const pushState = vi.fn();
  const replaceState = vi.fn();
  const render = vi.fn();

  const win = {
    location: {
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
      hostname: "localhost",
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
    },
    history: {
      state: null as unknown,
      pushState: pushState as any,
      replaceState: replaceState as any,
      back: vi.fn(),
    },
    dispatchEvent: vi.fn(),
    scrollTo: vi.fn(),
    scrollX: 0,
    scrollY: 0,
    addEventListener: vi.fn(),
    __NEXT_DATA__: {
      page: "/",
      query: {},
      isFallback: false,
      props: { pageProps: {} },
      __vinext: { pageModuleUrl: "/@fs/pages/index.js" },
    },
    __VINEXT_ROOT__: { render },
    __VINEXT_APP__: undefined,
    __VINEXT_LOCALE__: undefined,
    __VINEXT_LOCALES__: undefined,
    __VINEXT_DEFAULT_LOCALE__: undefined,
  };

  pushState.mockImplementation((state: unknown, _title: string, url: string) => {
    win.history.state = state;
    try {
      const parsed = new URL(url, "http://localhost");
      win.location.pathname = parsed.pathname;
      win.location.search = parsed.search;
      win.location.hash = parsed.hash;
      win.location.href = parsed.href;
    } catch {
      win.location.pathname = url;
      win.location.href = "http://localhost" + url;
    }
  });

  replaceState.mockImplementation((state: unknown, _title: string, url?: string) => {
    win.history.state = state;
    if (!url) return;
    try {
      const parsed = new URL(url, "http://localhost");
      win.location.pathname = parsed.pathname;
      win.location.search = parsed.search;
      win.location.hash = parsed.hash;
      win.location.href = parsed.href;
    } catch {
      win.location.pathname = url;
      win.location.href = "http://localhost" + url;
    }
  });

  return { win, pushState, replaceState, render };
}

function buildNavHtml(
  page: string,
  pageModuleUrl: string,
  query: Record<string, unknown> = {},
  i18n?: { locale: string; locales: string[]; defaultLocale: string },
): string {
  const nextDataScript = buildPagesNextDataScript({
    buildId: null,
    i18n: i18n ?? {},
    pageProps: { page },
    params: query,
    routePattern: page,
    safeJsonStringify,
    vinext: { pageModuleUrl },
  });
  return `<html><head></head><body>${nextDataScript}</body></html>`;
}

const PAGE_MODULE_URL = path.resolve(import.meta.dirname, "fixtures/client-navigation-page.tsx");

// Ported from Next.js test/e2e/ignore-invalid-popstateevent — Next.js writes
// `{ url, as, options, __N: true, key }` on every pushState/replaceState so
// the popstate handler can detect stale or non-Next events.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/router.ts (around L1916)
describe("Pages Router history state shape", () => {
  it("Router.push writes a Next-shaped history state including the active locale", async () => {
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const { win, pushState } = createNavWindow();
    Object.assign(win, {
      __VINEXT_LOCALE__: "en",
      __VINEXT_LOCALES__: ["en", "id"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });
    (globalThis as any).window = win;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/about",
            PAGE_MODULE_URL,
            {},
            { locale: "en", locales: ["en", "id"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;

      await Router.push("/about");

      // First arg of the latest pushState call is the state object.
      expect(pushState).toHaveBeenCalled();
      const lastCall = pushState.mock.calls.at(-1)!;
      const state = lastCall[0] as Record<string, unknown> & {
        options?: { locale?: string };
      };
      expect(state.__N).toBe(true);
      expect(typeof state.url).toBe("string");
      expect(typeof state.as).toBe("string");
      expect(state.options?.locale).toBe("en");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
    }
  });

  it("Router.push with an explicit locale stamps that locale into history state", async () => {
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const { win, pushState } = createNavWindow();
    Object.assign(win, {
      __VINEXT_LOCALE__: "en",
      __VINEXT_LOCALES__: ["en", "fr"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });
    (globalThis as any).window = win;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/about",
            PAGE_MODULE_URL,
            {},
            { locale: "fr", locales: ["en", "fr"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;

      await Router.push("/about", undefined, { locale: "fr" });

      const lastCall = pushState.mock.calls.at(-1)!;
      const state = lastCall[0] as { options?: { locale?: string } };
      expect(state.options?.locale).toBe("fr");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
    }
  });

  it("Router.push with locale: false records the default locale in history state", async () => {
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const { win, pushState } = createNavWindow();
    Object.assign(win, {
      __VINEXT_LOCALE__: "fr",
      __VINEXT_LOCALES__: ["en", "fr"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });
    (globalThis as any).window = win;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/about",
            PAGE_MODULE_URL,
            {},
            { locale: "en", locales: ["en", "fr"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;

      await Router.push("/about", undefined, { locale: false });

      const lastCall = pushState.mock.calls.at(-1)!;
      const state = lastCall[0] as { options?: { locale?: string } };
      // Next.js resolves locale: false to defaultLocale for transition tracking.
      expect(state.options?.locale).toBe("en");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
    }
  });
});

// Ported from Next.js test/e2e/ignore-invalid-popstateevent/with-i18n.test.ts
// and without-i18n.test.ts.
// Next.js drops the first popstate event whose state.options.locale equals the
// current locale AND state.as equals the current asPath (treating it as a
// browser-replay / Safari re-open), and processes the second identical event
// normally.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/router.ts (around L935-942)
describe("Pages Router popstate stale-state filter (i18n parity)", () => {
  async function installRuntime(win: ReturnType<typeof createNavWindow>["win"]) {
    const listeners = new Map<string, (event: any) => void>();
    win.addEventListener = vi.fn((type: string, handler: (event: any) => void) => {
      listeners.set(type, handler);
    }) as any;
    (globalThis as any).window = win;
    vi.resetModules();
    await import("../packages/vinext/src/shims/router.js");
    const { installPagesRouterRuntime } =
      await import("../packages/vinext/src/shims/pages-router-runtime.js");
    installPagesRouterRuntime();
    return listeners;
  }

  it("ignores the first popstate whose state matches the current locale and asPath", async () => {
    // Mirrors Next.js's `isFirstPopStateEvent && locale === state.options.locale
    // && state.as === asPath` early-exit. The most important assertion is that
    // we do NOT trigger a page fetch on Safari-style replay events.
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const originalCustomEvent = globalThis.CustomEvent;
    const { win } = createNavWindow();
    win.location.pathname = "/static";
    win.location.href = "http://localhost/static";
    Object.assign(win, {
      __VINEXT_LOCALE__: "sv",
      __VINEXT_LOCALES__: ["en", "sv"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });

    let routeChangeStartCount = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/[dynamic]",
            PAGE_MODULE_URL,
            {},
            { locale: "sv", locales: ["en", "sv"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;
    (globalThis as any).CustomEvent = class CustomEventMock {
      constructor(public type: string) {}
    } as any;

    try {
      const listeners = await installRuntime(win);
      const popstateHandler = listeners.get("popstate");
      expect(popstateHandler).toBeDefined();

      const routerModule = await import("../packages/vinext/src/shims/router.js");
      routerModule.default.events.on("routeChangeStart", () => {
        routeChangeStartCount += 1;
      });

      // First popstate: same locale, same as path → must be ignored.
      popstateHandler!({
        state: {
          url: "/[dynamic]",
          as: "/static",
          options: { locale: "sv" },
          __N: true,
          key: "",
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(routeChangeStartCount).toBe(0);
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
      (globalThis as any).CustomEvent = originalCustomEvent;
    }
  });

  it("does not ignore a first popstate when the locale differs from the current locale", async () => {
    // Parity with Next.js test/e2e/ignore-invalid-popstateevent/with-i18n.test.ts
    // "Don't ignore event with different locale".
    // We assert via the routeChangeStart event so we exercise the path even
    // when the test fixture's window/location doesn't differ from `_last…`.
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const originalCustomEvent = globalThis.CustomEvent;
    const { win } = createNavWindow();
    win.location.pathname = "/sv/static";
    win.location.href = "http://localhost/sv/static";
    Object.assign(win, {
      __VINEXT_LOCALE__: "sv",
      __VINEXT_LOCALES__: ["en", "sv"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });

    let routeChangeStartCount = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/[dynamic]",
            PAGE_MODULE_URL,
            {},
            { locale: "en", locales: ["en", "sv"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;
    (globalThis as any).CustomEvent = class CustomEventMock {
      constructor(public type: string) {}
    } as any;

    try {
      const listeners = await installRuntime(win);
      const popstateHandler = listeners.get("popstate");
      expect(popstateHandler).toBeDefined();

      const routerModule = await import("../packages/vinext/src/shims/router.js");
      routerModule.default.events.on("routeChangeStart", () => {
        routeChangeStartCount += 1;
      });

      // Simulate that the URL changed (back/forward navigated to a different
      // entry) so the hash-only fast-path doesn't swallow the event.
      win.location.pathname = "/en/static";
      win.location.href = "http://localhost/en/static";

      popstateHandler!({
        state: {
          url: "/[dynamic]",
          as: "/static",
          options: { locale: "en" },
          __N: true,
          key: "",
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      // Different locale → stale-filter must not skip; navigation proceeds.
      expect(routeChangeStartCount).toBe(1);
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
      (globalThis as any).CustomEvent = originalCustomEvent;
    }
  });

  it("ignores popstate events without state.__N (non-Next-router history entries)", async () => {
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const originalCustomEvent = globalThis.CustomEvent;
    const { win } = createNavWindow();
    win.location.pathname = "/static";
    win.location.href = "http://localhost/static";
    Object.assign(win, {
      __VINEXT_LOCALE__: "en",
      __VINEXT_LOCALES__: ["en", "sv"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock;
    (globalThis as any).CustomEvent = class CustomEventMock {
      constructor(public type: string) {}
    } as any;

    try {
      const listeners = await installRuntime(win);
      const popstateHandler = listeners.get("popstate");
      expect(popstateHandler).toBeDefined();

      // History entry from non-Next code (third-party history.pushState).
      // Mirrors Next.js's `if (!state.__N) return` early-exit.
      popstateHandler!({
        state: { foreign: true },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
      (globalThis as any).CustomEvent = originalCustomEvent;
    }
  });
});

// Ported from Next.js test/e2e/i18n-preferred-locale-detection — clicking a
// Link with no `locale` prop must keep the active locale; on the server,
// Router.push must carry the active locale through state for the popstate
// machinery and downstream consumers.
describe("Pages Router locale stickiness on programmatic navigation", () => {
  it("Router.push without an explicit locale preserves the current locale in history state", async () => {
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const { win, pushState } = createNavWindow();
    Object.assign(win, {
      __VINEXT_LOCALE__: "id",
      __VINEXT_LOCALES__: ["en", "id"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });
    (globalThis as any).window = win;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          buildNavHtml(
            "/about",
            PAGE_MODULE_URL,
            {},
            { locale: "id", locales: ["en", "id"], defaultLocale: "en" },
          ),
          { status: 200 },
        ),
    );

    try {
      vi.resetModules();
      const routerModule = await import("../packages/vinext/src/shims/router.js");
      const Router = routerModule.default;

      await Router.push("/about");

      const lastCall = pushState.mock.calls.at(-1)!;
      const state = lastCall[0] as { options?: { locale?: string } };
      expect(state.options?.locale).toBe("id");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
    }
  });
});

// The initial document entry is created by the browser with `state: null`. If
// we don't stamp it with Next.js-shaped state on install, a later
// back-navigation popstate has no recorded locale and the handler falls back
// to `window.__VINEXT_LOCALE__` — which may have been changed by an
// intervening locale-switching push, fetching the wrong locale's HTML for the
// initial entry. installPagesRouterRuntime() runs replaceState once at boot
// to close that gap.
describe("Pages Router initial-entry history state", () => {
  async function installRuntime(win: ReturnType<typeof createNavWindow>["win"]) {
    const listeners = new Map<string, (event: any) => void>();
    win.addEventListener = vi.fn((type: string, handler: (event: any) => void) => {
      listeners.set(type, handler);
    }) as any;
    (globalThis as any).window = win;
    vi.resetModules();
    await import("../packages/vinext/src/shims/router.js");
    const { installPagesRouterRuntime } =
      await import("../packages/vinext/src/shims/pages-router-runtime.js");
    installPagesRouterRuntime();
    return listeners;
  }

  it("install stamps the initial document entry with the active locale", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, replaceState } = createNavWindow();
    win.location.pathname = "/about";
    win.location.href = "http://localhost/about";
    Object.assign(win, {
      __VINEXT_LOCALE__: "fr",
      __VINEXT_LOCALES__: ["en", "fr"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });

    try {
      await installRuntime(win);

      // First replaceState call is the install-time stamp.
      expect(replaceState).toHaveBeenCalled();
      const firstCall = replaceState.mock.calls[0]!;
      const state = firstCall[0] as { __N?: true; options?: { locale?: string }; as?: string };
      expect(state.__N).toBe(true);
      expect(state.options?.locale).toBe("fr");
      expect(state.as).toBe("/about");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
    }
  });

  it("install does not overwrite pre-existing history state", async () => {
    const previousWindow = (globalThis as any).window;
    const { win, replaceState } = createNavWindow();
    win.history.state = { foreign: true };
    Object.assign(win, { __VINEXT_LOCALE__: "fr" });

    try {
      await installRuntime(win);
      expect(replaceState).not.toHaveBeenCalled();
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
    }
  });

  it("back-nav to the initial entry uses the stamped locale, not the live window global", async () => {
    // The regression this guards against: land on `/` under the default
    // locale "en" (browser URL unprefixed), push to `/fr/about` with locale
    // "fr" (flips window.__VINEXT_LOCALE__), hit back. Without an
    // install-time stamp the popstate handler reads the live window global
    // ("fr") and fetches `/fr` for the root entry — the wrong locale.
    // Default-locale roots route through a locale-qualified HTML endpoint,
    // so the wrong locale changes which HTML the page receives.
    const previousWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    const originalCustomEvent = globalThis.CustomEvent;
    const { win } = createNavWindow();
    win.location.pathname = "/";
    win.location.href = "http://localhost/";
    Object.assign(win, {
      __VINEXT_LOCALE__: "en",
      __VINEXT_LOCALES__: ["en", "fr"],
      __VINEXT_DEFAULT_LOCALE__: "en",
    });

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      fetchCalls.push(typeof input === "string" ? input : input.url);
      return new Response(
        buildNavHtml(
          "/",
          PAGE_MODULE_URL,
          {},
          { locale: "en", locales: ["en", "fr"], defaultLocale: "en" },
        ),
        { status: 200 },
      );
    }) as any;
    (globalThis as any).CustomEvent = class CustomEventMock {
      constructor(public type: string) {}
    } as any;

    try {
      const listeners = await installRuntime(win);
      const popstateHandler = listeners.get("popstate");
      expect(popstateHandler).toBeDefined();

      // Capture the install-time stamped state — this is what the browser
      // hands back on a popstate to the initial entry.
      const stampedState = win.history.state as { options?: { locale?: string }; as?: string };
      expect(stampedState.options?.locale).toBe("en");
      expect(stampedState.as).toBe("/");

      // Simulate a forward push to /fr/about (locale "fr"). We just need to
      // advance the popstate handler's internal trackers
      // (`_lastPathnameAndSearch`, `_isFirstPopStateEvent`) past boot — in
      // production this happens via Router.push, but driving the popstate
      // handler directly is simpler than mocking the full push flow.
      win.location.pathname = "/fr/about";
      win.location.href = "http://localhost/fr/about";
      popstateHandler!({
        state: { url: "/about", as: "/about", options: { locale: "fr" }, __N: true, key: "" },
      });
      await new Promise((r) => setTimeout(r, 0));
      fetchCalls.length = 0;

      // Now back: browser pathname returns to `/` and the popstate carries
      // the *initial-entry* state we stamped. The live window global has
      // flipped to "fr" from the prior forward nav.
      Object.assign(win, { __VINEXT_LOCALE__: "fr" });
      win.location.pathname = "/";
      win.location.href = "http://localhost/";

      popstateHandler!({ state: stampedState });
      await new Promise((r) => setTimeout(r, 0));

      // The fetch must use the *stamped* locale ("en") → /en, not /fr.
      expect(fetchCalls.length).toBeGreaterThan(0);
      const backFetchUrl = fetchCalls[0]!;
      expect(backFetchUrl).toBe("/en");
    } finally {
      vi.resetModules();
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
      globalThis.fetch = originalFetch;
      (globalThis as any).CustomEvent = originalCustomEvent;
    }
  });
});
