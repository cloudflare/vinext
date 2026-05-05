/**
 * Regression tests: RSC lazy stream context-clear bug + __VINEXT_RSC_NAV__ hydration embedding
 *
 * ── Bug 1: RSC lazy stream context-clear ────────────────────────────────────
 *
 * renderHTTPAccessFallbackPage() and renderErrorBoundaryPage() in
 * entries/app-rsc-entry.ts called setHeadersContext(null) / setNavigationContext(null)
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
 * The test sends a canonical .rsc request with x-rsc-context-test: <sentinel>
 * and asserts the sentinel value appears in the RSC flight response, proving
 * the layout's headers() call ran successfully during lazy stream consumption.
 *
 * ── Bug 2: __VINEXT_RSC_NAV__ missing from HTML (hydration mismatch) ────────
 *
 * useSyncExternalStore requires that the getServerSnapshot callback returns the
 * same value that was rendered by the server. For usePathname() and
 * useSearchParams(), the server snapshot is read from the navigation context
 * (setNavigationContext) which is populated from the request URL during RSC
 * rendering and passed through to the SSR environment.
 *
 * Without the fix, the browser entry had no way to know what pathname/
 * searchParams were used on the server — so getServerSnapshot fell back to "/"
 * and empty URLSearchParams regardless of the actual request URL. This caused
 * React hydration mismatch error #418 whenever any "use client" component
 * called usePathname() or useSearchParams().
 *
 * Fix: generateSsrEntry() embeds __VINEXT_RSC_NAV__ = { pathname, searchParams }
 * (where searchParams is an array of [key, value] pairs to preserve duplicates)
 * and __VINEXT_RSC_PARAMS__ = { ...params } as <script> tags in <head>.
 * generateBrowserEntry() reads self.__VINEXT_RSC_NAV__ before hydrateRoot()
 * and calls setNavigationContext() so the client snapshot matches the server.
 *
 * The tests verify:
 *   1. The HTML <head> contains the __VINEXT_RSC_NAV__ script tag
 *   2. The embedded pathname matches the actual request path
 *   3. The embedded searchParams matches the actual query string
 *   4. __VINEXT_RSC_PARAMS__ carries dynamic segment values
 *   5. The SSR-rendered values from usePathname()/useSearchParams() agree with
 *      the __VINEXT_RSC_NAV__ payload — ensuring getServerSnapshot will match
 *      the HTML React tries to hydrate
 *
 * Fixture: tests/fixtures/app-basic/app/nextjs-compat/nav-context-hydration/
 *   page.tsx   — RSC page rendering <NavInfo /> (a "use client" component)
 *   nav-info.tsx — "use client": renders usePathname(), useSearchParams()
 *   [id]/page.tsx — dynamic-segment variant for __VINEXT_RSC_PARAMS__ testing
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

// ── Shared server ─────────────────────────────────────────────────────────────
//
// Both suites target the same fixture (app-basic, appRouter: true).
// A single server instance is shared so the test run stays fast — spinning up
// a second Vite dev server would add ~5-10 s of cold-start compile time.

let _server: ViteDevServer;
let _baseUrl: string;

// Module-level beforeAll / afterAll manage the shared server lifetime.
beforeAll(async () => {
  ({ server: _server, baseUrl: _baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
    appRouter: true,
  }));

  // Warm up both fixtures so the first real test in each suite doesn't pay
  // the cold-start compilation cost.
  await Promise.all([
    fetch(`${_baseUrl}/nextjs-compat/rsc-context-lazy-stream.rsc`, {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
        "x-rsc-context-test": "warmup",
      },
    }),
    fetch(`${_baseUrl}/nextjs-compat/nav-context-hydration`),
  ]);
}, 60_000);

afterAll(async () => {
  await _server?.close();
});

// ── Suite 1: RSC lazy stream context-clear ─────────────────────────────────

const LAZY_ROUTE = "/nextjs-compat/rsc-context-lazy-stream";
const SENTINEL = "rsc-lazy-stream-sentinel-xyz";

describe("RSC lazy stream: headers() context survives until stream is consumed", () => {
  // ── Baseline: full-page HTML load ──────────────────────────────────────────

  it("full-page HTML: layout headers() context is available (baseline)", async () => {
    const res = await fetch(`${_baseUrl}${LAZY_ROUTE}`, {
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
    const res = await fetch(`${_baseUrl}${LAZY_ROUTE}.rsc`, {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
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
    const res = await fetch(`${_baseUrl}${LAZY_ROUTE}.rsc`, {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
        "x-rsc-context-test": SENTINEL,
      },
    });

    const body = await res.text();

    // Explicit negative assertion: if the bug were present, the layout would
    // fall back to "missing" because headers() returned null context.
    expect(body).not.toContain('"missing"');
    expect(body).not.toContain('data-request-id="missing"');
  });
});

// ── Suite 2: __VINEXT_RSC_NAV__ hydration embedding ──────────────────────────
//
// These tests verify the server embeds a correct __VINEXT_RSC_NAV__ payload so
// useSyncExternalStore's getServerSnapshot agrees with the SSR-rendered HTML.
//
// Fixture: tests/fixtures/app-basic/app/nextjs-compat/nav-context-hydration/
//   page.tsx       — RSC page that renders <NavInfo />
//   nav-info.tsx   — "use client": usePathname() → #nav-pathname,
//                                  useSearchParams() → #nav-search-q, etc.
//   [id]/page.tsx  — dynamic-segment variant

const NAV_ROUTE = "/nextjs-compat/nav-context-hydration";

describe("__VINEXT_RSC_NAV__: nav context embedded for hydration snapshot consistency", () => {
  // ── 1. Script tag is present ──────────────────────────────────────────────

  it("HTML contains a __VINEXT_RSC_NAV__ script tag", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // generateSsrEntry() emits:
    //   <script>self.__VINEXT_RSC_NAV__={"pathname":...,"searchParams":...}</script>
    expect(html).toContain("__VINEXT_RSC_NAV__");
  });

  it("HTML contains a __VINEXT_RSC_PARAMS__ script tag", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // generateSsrEntry() emits:
    //   <script>self.__VINEXT_RSC_PARAMS__={...}</script>
    expect(html).toContain("__VINEXT_RSC_PARAMS__");
  });

  // ── 2. Pathname is correct ────────────────────────────────────────────────

  it("__VINEXT_RSC_NAV__ pathname matches the request pathname", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    const html = await res.text();

    // Extract the JSON payload from the script tag.
    // The server emits: self.__VINEXT_RSC_NAV__=<json>;
    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match, "__VINEXT_RSC_NAV__ script tag not found").toBeTruthy();
    const nav = JSON.parse(match![1]);

    expect(nav.pathname).toBe(NAV_ROUTE);
  });

  it("__VINEXT_RSC_NAV__ pathname agrees with SSR-rendered usePathname() output", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    const html = await res.text();

    // The "use client" NavInfo component renders usePathname() into #nav-pathname.
    // During SSR this is resolved from the navigation context (same source as
    // __VINEXT_RSC_NAV__). Both must agree — if getServerSnapshot returns the
    // embedded pathname and it matches the SSR-rendered value, React won't detect
    // a mismatch.
    expect(html).toContain(`<span id="nav-pathname">${NAV_ROUTE}</span>`);

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    expect(nav.pathname).toBe(NAV_ROUTE);
  });

  // ── 3. searchParams are correct (no query string) ─────────────────────────

  it("__VINEXT_RSC_NAV__ searchParams is empty array when no query string", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    // searchParams is serialised as [...urlSearchParams.entries()] — an array of
    // [key, value] pairs — to preserve duplicate keys (e.g. ?tag=a&tag=b).
    // With no query string it should be an empty array.
    expect(nav.searchParams).toEqual([]);
  });

  it("SSR-rendered useSearchParams() returns empty string when no query string", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}`);
    const html = await res.text();

    // #nav-search-q renders searchParams.get("q") ?? "" — should be ""
    expect(html).toContain('<span id="nav-search-q"></span>');
    // #nav-search-string renders searchParams.toString() — should be ""
    expect(html).toContain('<span id="nav-search-string"></span>');
  });

  // ── 4. searchParams are correct (with query string) ───────────────────────
  //
  // This is the critical hydration parity test. Without __VINEXT_RSC_NAV__:
  //   - SSR renders: <span id="nav-search-q">hello</span>
  //   - getServerSnapshot returns: new URLSearchParams() → ""
  //   → React sees "hello" ≠ "" → hydration mismatch error #418
  //
  // With __VINEXT_RSC_NAV__:
  //   - SSR renders: <span id="nav-search-q">hello</span>
  //   - browser entry calls setNavigationContext with new URLSearchParams([["q","hello"]])
  //   - getServerSnapshot returns: "hello"
  //   → React sees "hello" = "hello" → no mismatch

  it("__VINEXT_RSC_NAV__ searchParams carries query params from request URL", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=hello&page=3`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    // Serialised as array of [key, value] pairs to preserve duplicates.
    expect(nav.searchParams).toEqual([
      ["q", "hello"],
      ["page", "3"],
    ]);
  });

  it("__VINEXT_RSC_NAV__ searchParams agrees with SSR-rendered useSearchParams() output", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=hello&page=3`);
    const html = await res.text();

    // SSR-rendered output from the "use client" component
    expect(html).toContain('<span id="nav-search-q">hello</span>');
    expect(html).toContain('<span id="nav-search-page">3</span>');

    // Embedded payload must match
    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    // new URLSearchParams(nav.searchParams) reconstructs the same params
    const sp = new URLSearchParams(nav.searchParams);
    expect(sp.get("q")).toBe("hello");
    expect(sp.get("page")).toBe("3");
  });

  it("SSR-rendered useSearchParams() reflects query params (confirms parity source)", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=hello&page=3`);
    const html = await res.text();

    // The SSR path: RSC environment sets navigation context from request URL,
    // passes it to SSR environment via handleSsr(rscStream, navContext, ...).
    // The SSR environment's useSearchParams() reads navContext.searchParams.
    // The __VINEXT_RSC_NAV__ payload comes from the same navContext.
    // Both should reflect the request query string.
    expect(html).toContain('<span id="nav-search-q">hello</span>');
    expect(html).toContain('<span id="nav-search-page">3</span>');
    expect(html).toContain(`<span id="nav-pathname">${NAV_ROUTE}</span>`);
  });

  // ── 5. Special characters in searchParams are safely serialised ───────────

  it("__VINEXT_RSC_NAV__ searchParams handles special characters without XSS", async () => {
    // Ensure the JSON serialisation (safeJsonStringify) encodes characters
    // that could break out of a <script> tag if embedded raw.
    // The server uses safeJsonStringify which encodes < > & / to unicode escapes.
    const specialQ = "foo<bar>&baz";
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=${encodeURIComponent(specialQ)}`);
    const html = await res.text();

    // The raw string must NOT appear literally inside the <script> tag —
    // safeJsonStringify encodes < and > as \u003c / \u003e.
    // A naive JSON.stringify would emit: {"q":"foo<bar>&baz"} which allows
    // </script> injection.
    expect(html).not.toContain(`"q":"${specialQ}"`);

    // But when we parse the embedded JSON, the value round-trips correctly.
    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);
    const sp = new URLSearchParams(nav.searchParams);
    expect(sp.get("q")).toBe(specialQ);
  });

  // ── 6. __VINEXT_RSC_PARAMS__ for dynamic segment routes ──────────────────
  //
  // When the route has a dynamic segment (e.g. /nav-context-hydration/hello),
  // __VINEXT_RSC_PARAMS__ must carry { id: "hello" }.
  // The browser entry reads self.__VINEXT_RSC_PARAMS__ and passes it as
  // params: to setNavigationContext(), so useParams() returns the right value
  // during client hydration.

  it("__VINEXT_RSC_PARAMS__ contains dynamic segment value for [id] route", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}/hello`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_PARAMS__=(\{[^<]*\})/);
    expect(match, "__VINEXT_RSC_PARAMS__ script tag not found").toBeTruthy();
    const params = JSON.parse(match![1]);

    expect(params.id).toBe("hello");
  });

  it("__VINEXT_RSC_NAV__ pathname is correct for dynamic segment route", async () => {
    const dynamicPath = `${NAV_ROUTE}/hello`;
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    expect(nav.pathname).toBe(dynamicPath);
  });

  it("__VINEXT_RSC_NAV__ pathname agrees with SSR-rendered usePathname() for dynamic route", async () => {
    const dynamicPath = `${NAV_ROUTE}/hello`;
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    const html = await res.text();

    // The "use client" NavInfo component also renders on the dynamic page.
    // Its usePathname() output must match __VINEXT_RSC_NAV__.pathname.
    expect(html).toContain(`<span id="nav-pathname">${dynamicPath}</span>`);

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);
    expect(nav.pathname).toBe(dynamicPath);
  });

  // ── 7. Script tags appear before </head> ─────────────────────────────────
  //
  // Both __VINEXT_RSC_NAV__ and __VINEXT_RSC_PARAMS__ are injected into <head>
  // by generateSsrEntry(). They must appear before </head> so they are always
  // available by the time the bootstrap script runs and calls main().
  // If they were injected into the body stream they could arrive after
  // hydrateRoot() is called, making the hydration snapshot stale.

  it("__VINEXT_RSC_NAV__ and __VINEXT_RSC_PARAMS__ are injected before </head>", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=timing`);
    const html = await res.text();

    const headEnd = html.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);

    const navIdx = html.indexOf("__VINEXT_RSC_NAV__");
    const paramsIdx = html.indexOf("__VINEXT_RSC_PARAMS__");

    expect(navIdx).toBeGreaterThan(-1);
    expect(paramsIdx).toBeGreaterThan(-1);

    // Both script tags must appear before </head>
    expect(navIdx).toBeLessThan(headEnd);
    expect(paramsIdx).toBeLessThan(headEnd);
  });

  // ── 8. pathname uses the clean path, not the raw URL ─────────────────────
  //
  // The navigation context is built from cleanPathname (the URL pathname with
  // the trailing slash normalised). This must be the value embedded in
  // __VINEXT_RSC_NAV__, not the raw URL including query string.

  it("__VINEXT_RSC_NAV__ pathname does not include query string", async () => {
    const res = await fetch(`${_baseUrl}${NAV_ROUTE}?q=shouldnotbehere`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    // pathname must be just the path, not "…?q=shouldnotbehere"
    expect(nav.pathname).not.toContain("?");
    expect(nav.pathname).not.toContain("shouldnotbehere");
    expect(nav.pathname).toBe(NAV_ROUTE);
  });
});
