/**
 * ALS (AsyncLocalStorage) Isolation Tests
 *
 * Regression tests for GHSA-4394-xfwv-gvvj: Cross-request data leakage via
 * shared mutable _fallbackState in headers.ts, navigation-state.ts, and
 * fetch-cache.ts.
 *
 * These tests verify that concurrent requests get isolated state through
 * AsyncLocalStorage, and that one request's headers/cookies/navigation
 * context never leaks into another request.
 */

import { describe, it, expect } from "vitest";

describe("ALS per-request isolation", () => {
  it("concurrent requests see their own headers context (no cross-request leakage)", async () => {
    const {
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    // We need to dynamically import headers() since it reads from ALS
    const { headers: headersFn } = await import("../../packages/vinext/src/shims/headers.js");

    const CONCURRENCY = 20;
    const results: { id: string; sawId: string }[] = [];

    // Launch N concurrent "requests", each with a unique X-Request-Id header.
    // Each request yields (via setTimeout) before reading headers() to
    // simulate real async work (DB queries, fetch calls, etc.).
    const promises = Array.from({ length: CONCURRENCY }, (_, i) => {
      const id = `req-${i}`;
      const request = new Request("http://localhost/test", {
        headers: { "x-request-id": id },
      });
      const ctx = headersContextFromRequest(request);

      return runWithHeadersContext(ctx, async () => {
        // Yield to the event loop — this is where cross-request leakage
        // would occur if ALS isn't working (another request overwrites
        // the shared _fallbackState while we're suspended).
        await new Promise((r) => setTimeout(r, Math.random() * 10));

        const h = await headersFn();
        const sawId = h.get("x-request-id") ?? "MISSING";
        results.push({ id, sawId });
      });
    });

    await Promise.all(promises);

    expect(results).toHaveLength(CONCURRENCY);
    for (const { id, sawId } of results) {
      expect(sawId).toBe(id);
    }
  });

  it("concurrent requests see their own navigation context", async () => {
    // Import the navigation-state module to register ALS-backed accessors
    await import("../../packages/vinext/src/shims/navigation-state.js");
    const { runWithNavigationContext } = await import(
      "../../packages/vinext/src/shims/navigation-state.js"
    );

    // After navigation-state registers its accessors, getNavigationContext
    // reads from the ALS-backed store
    const { setNavigationContext, getNavigationContext } = await import(
      "../../packages/vinext/src/shims/navigation.js"
    );

    const CONCURRENCY = 20;
    const results: { pathname: string; sawPathname: string }[] = [];

    const promises = Array.from({ length: CONCURRENCY }, (_, i) => {
      const pathname = `/page-${i}`;

      return runWithNavigationContext(async () => {
        setNavigationContext({
          pathname,
          searchParams: new URLSearchParams(),
          params: {},
        });

        // Yield — cross-request leakage window
        await new Promise((r) => setTimeout(r, Math.random() * 10));

        const ctx = getNavigationContext();
        const sawPathname = ctx?.pathname ?? "MISSING";
        results.push({ pathname, sawPathname });
      });
    });

    await Promise.all(promises);

    expect(results).toHaveLength(CONCURRENCY);
    for (const { pathname, sawPathname } of results) {
      expect(sawPathname).toBe(pathname);
    }
  });

  it("concurrent fetch cache scopes are independent", async () => {
    const { runWithFetchCache, getCollectedFetchTags } = await import(
      "../../packages/vinext/src/shims/fetch-cache.js"
    );

    const CONCURRENCY = 20;
    const results: string[][] = [];

    // Each scope starts with empty tags. If ALS isolation fails, scopes
    // would share the _fallbackState and see each other's tags.
    const promises = Array.from({ length: CONCURRENCY }, () =>
      runWithFetchCache(async () => {
        // Yield — cross-request leakage window
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        results.push(getCollectedFetchTags());
      }),
    );

    await Promise.all(promises);

    expect(results).toHaveLength(CONCURRENCY);
    for (const tags of results) {
      // Each scope should see empty tags — no leakage from other scopes
      expect(tags).toEqual([]);
    }
  });

  it("cookies from one request don't leak into another", async () => {
    const {
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");
    const { cookies: cookiesFn } = await import(
      "../../packages/vinext/src/shims/headers.js"
    );

    const CONCURRENCY = 20;
    const results: { session: string; sawSession: string }[] = [];

    const promises = Array.from({ length: CONCURRENCY }, (_, i) => {
      const session = `session-${i}`;
      const request = new Request("http://localhost/test", {
        headers: { cookie: `session=${session}` },
      });
      const ctx = headersContextFromRequest(request);

      return runWithHeadersContext(ctx, async () => {
        // Yield — cross-request leakage window
        await new Promise((r) => setTimeout(r, Math.random() * 10));

        const c = await cookiesFn();
        const sawSession = c.get("session")?.value ?? "MISSING";
        results.push({ session, sawSession });
      });
    });

    await Promise.all(promises);

    expect(results).toHaveLength(CONCURRENCY);
    for (const { session, sawSession } of results) {
      expect(sawSession).toBe(session);
    }
  });
});
