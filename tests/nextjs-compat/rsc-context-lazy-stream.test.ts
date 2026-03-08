/**
 * Regression test: RSC lazy stream context-clear bug
 *
 * Bug: renderHTTPAccessFallbackPage() and renderErrorBoundaryPage() in
 * app-dev-server.ts called setHeadersContext(null) / setNavigationContext(null)
 * immediately after renderToReadableStream() returned — before the RSC stream
 * was consumed by the client.
 *
 * setHeadersContext(null) mutates the live ALS store in-place:
 *   state.headersContext = null
 *
 * The ALS store is still alive — the ReadableStream holds a reference to it
 * through its async continuation chain. So any async server component that
 * runs during lazy stream consumption (e.g. a layout that calls headers(), like
 * NextIntlClientProviderServer calling getMessages()) sees headersContext = null
 * and throws, producing a broken RSC stream instead of rendered content.
 *
 * Fix: remove the early setHeadersContext(null) / setNavigationContext(null)
 * calls from the RSC branches of renderHTTPAccessFallbackPage() and
 * renderErrorBoundaryPage(). The ALS scope from runWithHeadersContext() unwinds
 * naturally when all async continuations (including stream consumption) complete.
 *
 * Fixture: tests/fixtures/app-basic/app/nextjs-compat/rsc-context-lazy-stream/
 *   layout.tsx    — async layout that calls headers(), reads x-rsc-context-test
 *   page.tsx      — calls notFound(), triggering renderHTTPAccessFallbackPage()
 *   not-found.tsx — rendered by renderHTTPAccessFallbackPage() inside the layout
 *
 * The test sends Accept: text/x-component (the real RSC request header —
 * isRscRequest is determined by accept.includes("text/x-component"), NOT by
 * an "RSC" header) with x-rsc-context-test: <sentinel> and asserts the sentinel
 * value appears in the RSC flight response, proving the layout's headers() call
 * ran successfully during lazy stream consumption.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

const ROUTE = "/nextjs-compat/rsc-context-lazy-stream";
const SENTINEL = "rsc-lazy-stream-sentinel-xyz";

describe("RSC lazy stream: headers() context survives until stream is consumed", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up so the first real test isn't measuring cold-start compile time
    await fetch(`${baseUrl}${ROUTE}`, {
      headers: { Accept: "text/x-component", "x-rsc-context-test": "warmup" },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Baseline: full-page HTML load ──────────────────────────────────────────

  it("full-page HTML: layout headers() context is available (baseline)", async () => {
    const res = await fetch(`${baseUrl}${ROUTE}`, {
      headers: { "x-rsc-context-test": SENTINEL },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    // The layout reads x-rsc-context-test from headers() and puts it in
    // data-request-id. Confirms the fixture works on the HTML path.
    expect(html).toContain(`data-request-id="${SENTINEL}"`);
    // not-found.tsx rendered
    expect(html).toContain('id="rsc-context-not-found"');
  });

  // ── Regression: RSC request path ───────────────────────────────────────────
  //
  // This is the path where the bug manifested. The flow is:
  //
  //   1. Request arrives with Accept: text/x-component → isRscRequest = true
  //   2. page.tsx calls notFound() → throws NEXT_NOT_FOUND digest
  //   3. vinext catches it → calls renderHTTPAccessFallbackPage(route, 404, true, ...)
  //   4. Builds element: not-found.tsx wrapped in ancestor layouts (including
  //      layout.tsx which calls headers() asynchronously)
  //   5. renderToReadableStream(element) → returns RSC stream immediately
  //      (the stream shell is ready but async layout body hasn't run yet)
  //   6. BUG: setHeadersContext(null) called here — wipes ALS store in-place
  //   7. Stream is consumed: layout.tsx async body runs NOW, calls headers()
  //   8. headers() returns null context → x-rsc-context-test = "missing"
  //
  // With the fix, step 6 does not happen. headers() in step 7 returns the
  // correct context and SENTINEL appears in the RSC flight response.

  it("RSC request: layout headers() context survives lazy stream consumption (regression)", async () => {
    const res = await fetch(`${baseUrl}${ROUTE}`, {
      headers: {
        Accept: "text/x-component",
        "x-rsc-context-test": SENTINEL,
      },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/x-component");

    const body = await res.text();

    // The layout sets data-request-id from headers("x-rsc-context-test").
    // In the RSC flight format this appears as a prop in the serialized tree.
    // If the early-clear bug is present, the layout sees null context and
    // data-request-id is "missing" — SENTINEL is absent from the flight body.
    expect(body).toContain(SENTINEL);

    // Also confirm not-found.tsx was rendered (not a raw error response)
    expect(body).toContain("rsc-context-not-found");
  });

  it("RSC request: data-request-id is not 'missing' (context was not null)", async () => {
    const res = await fetch(`${baseUrl}${ROUTE}`, {
      headers: {
        Accept: "text/x-component",
        "x-rsc-context-test": SENTINEL,
      },
    });

    const body = await res.text();

    // Explicit negative assertion: if the bug were present, the layout would
    // fall back to "missing" because headers() returned null context.
    expect(body).not.toContain('"missing"');
    expect(body).not.toContain("data-request-id=\"missing\"");
  });
});
