/**
 * App Router router.prefetch invalid-URL parity.
 *
 * Ported from Next.js: test/e2e/app-dir/app-prefetch/prefetching.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch/prefetching.test.ts
 *
 * Next.js validates the href passed to `router.prefetch` via
 * `createPrefetchURL` and throws an Error when the value cannot be parsed
 * into a URL relative to `window.location.href`. The thrown error is
 * surfaced by the surrounding error boundary in the test app, and the
 * upstream test asserts the rendered `<h1>` reads "A prefetch threw an
 * error". The canonical message thrown by Next.js is:
 *
 *   Cannot prefetch '<href>' because it cannot be converted to a URL.
 *
 * See: packages/next/src/client/components/app-router-utils.ts:27-29.
 *
 * Vinext previously swallowed unparseable hrefs (caught inside the async
 * prefetch IIFE and reported as `console.error("[vinext] RSC prefetch setup
 * error:", error)`), so the upstream test failed. This file pins the parity
 * fix: an invalid URL throws synchronously from `router.prefetch`, while
 * normal hrefs continue to work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

type Navigation = typeof import("../packages/vinext/src/shims/navigation.js");
let appRouterInstance: Navigation["appRouterInstance"];

beforeEach(async () => {
  // Set window BEFORE importing so isServer evaluates to false in the shim.
  // INVALID_URL = "///" needs `new URL("///", window.location.href)` to throw,
  // which it does for both http:// and https:// base URLs in modern runtimes.
  (globalThis as any).window = {
    __VINEXT_RSC_PREFETCH_CACHE__: new Map(),
    __VINEXT_RSC_PREFETCHED_URLS__: new Set(),
    location: {
      origin: "http://localhost",
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
    },
    addEventListener: () => {},
    history: { pushState: () => {}, replaceState: () => {}, state: null },
    dispatchEvent: () => {},
  };
  vi.resetModules();
  const nav = await import("../packages/vinext/src/shims/navigation.js");
  appRouterInstance = nav.appRouterInstance;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).fetch;
});

describe("App Router router.prefetch with an invalid URL", () => {
  // Mirrors Next.js's INVALID_URL fixture:
  // .nextjs-ref/test/e2e/app-dir/app-prefetch/app/invalid-url/invalid-url.js
  const INVALID_URL = "///";

  it("throws the canonical error message", () => {
    expect(() => appRouterInstance.prefetch(INVALID_URL)).toThrowError(
      `Cannot prefetch '${INVALID_URL}' because it cannot be converted to a URL.`,
    );
  });

  it("does not throw on a normal pathname", () => {
    // Stub fetch so the async prefetch IIFE doesn't try to hit the network.
    (globalThis as any).fetch = vi
      .fn()
      .mockResolvedValue(new Response(new ArrayBuffer(0), { status: 200 }));
    expect(() => appRouterInstance.prefetch("/safe")).not.toThrow();
  });

  it("does not throw on an absolute http URL", () => {
    (globalThis as any).fetch = vi
      .fn()
      .mockResolvedValue(new Response(new ArrayBuffer(0), { status: 200 }));
    expect(() => appRouterInstance.prefetch("http://localhost/safe")).not.toThrow();
  });
});
