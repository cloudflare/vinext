/**
 * Pages Router → App Router prefetch detection.
 *
 * Ported from Next.js: test/e2e/app-dir/app/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
 *   it('should successfully detect app route during prefetch', ...)
 *
 * In a hybrid Pages Router + App Router app, when the Pages Router prefetches
 * a `<Link href="/path">` whose target is actually an App Router route, Next.js
 * marks the route on the Pages Router singleton with
 * `router.components[urlPathname] = { __appRouter: true }` so the subsequent
 * navigation handoff to the App Router can be detected.
 *
 * See: .nextjs-ref/packages/next/src/shared/lib/router/router.ts:2525 — when
 * the bloom-filter `_bfl` check matches (i.e., the target is an app route),
 * Next.js records the route on `this.components` with `__appRouter: true`.
 *
 * Vinext does not use a bloom filter; the App Router prefetch route manifest
 * (`__VINEXT_LINK_PREFETCH_ROUTES__`) is available on the client and the same
 * pattern matcher used by Link's App Router auto-prefetch decides if the
 * target is an app route. This file pins that signal.
 *
 * Issue: https://github.com/cloudflare/vinext/issues/1526
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

type FakeWindow = {
  location: {
    pathname: string;
    search: string;
    hash: string;
    href: string;
    origin: string;
    assign: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
  };
  history: { state: null; pushState(): void; replaceState(): void };
  addEventListener(): void;
  dispatchEvent(): void;
  __VINEXT_LINK_PREFETCH_ROUTES__: Array<{
    canPrefetchLoadingShell: boolean;
    patternParts: string[];
    isDynamic: boolean;
  }>;
  next?: unknown;
};

function installFakeBrowserGlobals(
  prefetchRoutes: Array<{
    canPrefetchLoadingShell: boolean;
    patternParts: string[];
    isDynamic: boolean;
  }>,
): FakeWindow {
  // Minimal fake window/document so importing shims/router.ts (which touches
  // window at module load to attach popstate) does not crash.
  const fakeWindow: FakeWindow = {
    location: {
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
      origin: "http://localhost",
      assign: vi.fn(),
      replace: vi.fn(),
    },
    history: { state: null, pushState() {}, replaceState() {} },
    addEventListener() {},
    dispatchEvent() {},
    __VINEXT_LINK_PREFETCH_ROUTES__: prefetchRoutes,
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  (globalThis as { document?: unknown }).document = {
    addEventListener() {},
    createElement: () => ({
      setAttribute() {},
      set rel(_: string) {},
      set href(_: string) {},
      set as(_: string) {},
      set crossOrigin(_: string) {},
    }),
    head: { appendChild() {} },
  };
  return fakeWindow;
}

describe("Pages Router records app routes as detected on prefetch", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exposes a `components` object on the Pages Router singleton", async () => {
    installFakeBrowserGlobals([]);
    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;
    expect(Router.components).toBeDefined();
    expect(typeof Router.components).toBe("object");
  });

  it("marks a prefetched App Router target as { __appRouter: true } on components", async () => {
    installFakeBrowserGlobals([
      // /dashboard is a static App Router route
      { canPrefetchLoadingShell: false, patternParts: ["dashboard"], isDynamic: false },
    ]);

    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;

    await Router.prefetch("/dashboard");

    expect(Router.components["/dashboard"]).toEqual({ __appRouter: true });
  });

  it("does not mark unrelated routes that are not in the App Router manifest", async () => {
    installFakeBrowserGlobals([
      { canPrefetchLoadingShell: false, patternParts: ["dashboard"], isDynamic: false },
    ]);

    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;

    await Router.prefetch("/some-random-pages-route");

    expect(Router.components["/some-random-pages-route"]).toBeUndefined();
  });

  it("is exposed via window.next.router.components", async () => {
    installFakeBrowserGlobals([
      { canPrefetchLoadingShell: false, patternParts: ["dashboard"], isDynamic: false },
    ]);

    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;

    await Router.prefetch("/dashboard");

    // The Next.js test reads through window.next.router.components — verify
    // the singleton wired into window.next is the same object.
    const win = (
      globalThis as { window: { next?: { router?: { components?: Record<string, unknown> } } } }
    ).window;
    expect(win.next?.router?.components?.["/dashboard"]).toEqual({ __appRouter: true });
    expect(win.next?.router).toBe(Router);
  });

  it("stores the marker under the trailing-slash-stripped key (trailingSlash: true compat)", async () => {
    // When trailingSlash:true, link.tsx normalises /about → /about/ before
    // calling markAppRouteDetectedOnPrefetch. The key must still be stored
    // without the trailing slash so the read-side lookup in performNavigation
    // (which also strips) always hits regardless of which form was written.
    installFakeBrowserGlobals([
      { canPrefetchLoadingShell: false, patternParts: ["about"], isDynamic: false },
    ]);

    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;

    // Simulate the call that link.tsx makes when trailingSlash:true adds a slash.
    await Router.prefetch("/about/");

    // Key must be the stripped form, not "/about/".
    expect(Router.components["/about"]).toEqual({ __appRouter: true });
    expect(Router.components["/about/"]).toBeUndefined();
  });

  it("fast-paths to window.location.assign when the __appRouter marker is set", async () => {
    // This pins the new performNavigation fast-path: after a prefetch that
    // records the __appRouter marker, the next navigation must call
    // window.location.assign (hard nav) rather than falling through to the
    // Pages Router SPA fetch cycle.
    const fakeWindow = installFakeBrowserGlobals([
      { canPrefetchLoadingShell: false, patternParts: ["about"], isDynamic: false },
    ]);

    const routerModule = await import("../packages/vinext/src/shims/router.js");
    const Router = routerModule.default;

    // 1. Prefetch records the marker.
    await Router.prefetch("/about");
    expect(Router.components["/about"]).toEqual({ __appRouter: true });

    // 2. Navigate — the fast-path must invoke window.location.assign.
    //    We don't await the returned Promise because the fast-path returns a
    //    never-resolving Promise (matching Next.js's own "freeze" pattern).
    //    There is no `await` between performNavigation entry and the
    //    fast-path return, so `assign` must have fired synchronously by the
    //    time `push()` returns — assert immediately to pin that synchronicity
    //    (the hard navigation must not lose a race against the SPA path).
    void Router.push("/about");

    expect(fakeWindow.location.assign).toHaveBeenCalledWith(expect.stringContaining("/about"));
  });
});
