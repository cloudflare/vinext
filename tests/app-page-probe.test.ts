import { describe, expect, it, vi } from "vite-plus/test";
import {
  probeAppPage,
  probeAppPageBeforeRender,
} from "../packages/vinext/src/server/app-page-probe.js";

// Mirrors makeThenableParams() from app-rsc-entry.ts — the function that
// converts raw null-prototype params into objects that work with both
// `await params` (Next.js 15+) and `params.id` (pre-15).
function makeThenableParams<T extends Record<string, unknown>>(obj: T): Promise<T> & T {
  const plain = { ...obj } as T;
  return Object.assign(Promise.resolve(plain), plain);
}

describe("app page probe helpers", () => {
  it("handles layout special errors before probing the page", async () => {
    const layoutError = new Error("layout failed");
    const pageProbe = vi.fn(() => "page");
    const renderLayoutSpecialError = vi.fn(
      async () => new Response("layout-fallback", { status: 404 }),
    );
    const renderPageSpecialError = vi.fn();
    const probedLayouts: number[] = [];

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 3,
      probeLayoutAt(layoutIndex) {
        probedLayouts.push(layoutIndex);
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      probePage: pageProbe,
      renderLayoutSpecialError,
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === layoutError
          ? {
              kind: "http-access-fallback",
              statusCode: 404,
            }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(probedLayouts).toEqual([2, 1]);
    expect(pageProbe).not.toHaveBeenCalled();
    expect(renderLayoutSpecialError).toHaveBeenCalledWith(
      {
        kind: "http-access-fallback",
        statusCode: 404,
      },
      1,
    );
    expect(renderPageSpecialError).not.toHaveBeenCalled();
    expect(result.response?.status).toBe(404);
    await expect(result.response?.text()).resolves.toBe("layout-fallback");
  });

  it("falls through to the page probe when layout failures are not special", async () => {
    const layoutError = new Error("ordinary layout failure");
    const pageProbe = vi.fn(() => null);
    const renderLayoutSpecialError = vi.fn();

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 2,
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      probePage: pageProbe,
      renderLayoutSpecialError,
      renderPageSpecialError() {
        throw new Error("should not render a page special error");
      },
      resolveSpecialError() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(result.response).toBeNull();
    expect(pageProbe).toHaveBeenCalledTimes(1);
    expect(renderLayoutSpecialError).not.toHaveBeenCalled();
  });

  it("turns special page probe failures into immediate responses", async () => {
    const pageError = new Error("page failed");
    const renderPageSpecialError = vi.fn(
      async () => new Response("page-fallback", { status: 307 }),
    );

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 0,
      probeLayoutAt() {
        throw new Error("should not probe layouts");
      },
      probePage() {
        return Promise.reject(pageError);
      },
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
      },
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === pageError
          ? {
              kind: "redirect",
              location: "/target",
              statusCode: 307,
            }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(renderPageSpecialError).toHaveBeenCalledWith({
      kind: "redirect",
      location: "/target",
      statusCode: 307,
    });
    expect(result.response?.status).toBe(307);
    await expect(result.response?.text()).resolves.toBe("page-fallback");
  });

  it("propagates layoutFlags from layout probe result", async () => {
    const pageProbe = vi.fn(() => null);

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 2,
      probeLayoutAt() {
        return null;
      },
      probePage: pageProbe,
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
      },
      renderPageSpecialError() {
        throw new Error("should not render a page special error");
      },
      resolveSpecialError() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        buildTimeClassifications: new Map([
          [0, "static"],
          [1, "dynamic"],
        ]),
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });

    expect(result.response).toBeNull();
    expect(result.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/admin": "d",
    });
  });

  it("still handles special errors with classification enabled", async () => {
    const layoutError = new Error("layout failed");

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 2,
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      probePage() {
        throw new Error("should not probe page");
      },
      renderLayoutSpecialError: vi.fn(async () => new Response("layout-fallback", { status: 404 })),
      renderPageSpecialError() {
        throw new Error("should not render a page special error");
      },
      resolveSpecialError(error) {
        return error === layoutError ? { kind: "http-access-fallback", statusCode: 404 } : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });

    // Special error response should still be returned
    expect(result.response?.status).toBe(404);
  });

  // ── Regression: probePage must receive thenable params/searchParams ──
  // probePage() in the generated entry was passing raw null-prototype params
  // (from trieMatch) instead of thenable params. Pages using `await params`
  // (Next.js 15+ pattern) threw TypeError during probe, causing the probe to
  // silently swallow the error instead of detecting notFound()/redirect().

  it("detects notFound() from an async-params page when params are thenable", async () => {
    const NOT_FOUND_ERROR = new Error("NEXT_NOT_FOUND");
    const params = Object.create(null);
    params.id = "invalid";

    // Simulates a page that does `const { id } = await params; notFound()`
    async function AsyncParamsPage(props: { params: Promise<{ id: string }> }) {
      const { id } = await props.params;
      if (id === "invalid") throw NOT_FOUND_ERROR;
      return null;
    }

    const renderPageSpecialError = vi.fn(
      async () => new Response("not-found-fallback", { status: 404 }),
    );

    // With thenable params, the probe should catch notFound()
    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 0,
      probeLayoutAt() {
        return null;
      },
      probePage() {
        return AsyncParamsPage({ params: makeThenableParams(params) });
      },
      renderLayoutSpecialError() {
        throw new Error("unreachable");
      },
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === NOT_FOUND_ERROR ? { kind: "http-access-fallback", statusCode: 404 } : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(renderPageSpecialError).toHaveBeenCalledOnce();
    expect(result.response?.status).toBe(404);
  });

  it("detects redirect() from an async-searchParams page when searchParams are thenable", async () => {
    const REDIRECT_ERROR = new Error("NEXT_REDIRECT");

    // Simulates a page that does `const { dest } = await searchParams; redirect(dest)`
    async function AsyncSearchPage(props: {
      params: Promise<Record<string, unknown>>;
      searchParams: Promise<{ dest?: string }>;
    }) {
      const { dest } = await props.searchParams;
      if (dest) throw REDIRECT_ERROR;
      return null;
    }

    const renderPageSpecialError = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: "/about" } }),
    );

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 0,
      probeLayoutAt() {
        return null;
      },
      probePage() {
        return AsyncSearchPage({
          params: makeThenableParams({}),
          searchParams: makeThenableParams({ dest: "/about" }),
        });
      },
      renderLayoutSpecialError() {
        throw new Error("unreachable");
      },
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === REDIRECT_ERROR
          ? { kind: "redirect", location: "/about", statusCode: 307 }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(renderPageSpecialError).toHaveBeenCalledOnce();
    expect(result.response?.status).toBe(307);
  });

  it("probe silently fails when searchParams is omitted and page awaits it", async () => {
    const REDIRECT_ERROR = new Error("NEXT_REDIRECT");

    // When the old probePage() omitted searchParams, the component received
    // undefined for that prop. `await undefined` produces undefined, then
    // destructuring undefined throws TypeError. The probe catches it but
    // doesn't recognize it as a special error, so it returns null.
    const renderPageSpecialError = vi.fn(async () => new Response(null, { status: 307 }));

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      layoutCount: 0,
      probeLayoutAt() {
        return null;
      },
      probePage() {
        // Simulate what happens at runtime when searchParams is not passed:
        // the page component receives no searchParams prop, then tries to
        // destructure it after await. This throws TypeError.
        return Promise.resolve().then(() => {
          throw new TypeError("Cannot destructure property 'dest' of undefined");
        });
      },
      renderLayoutSpecialError() {
        throw new Error("unreachable");
      },
      renderPageSpecialError,
      resolveSpecialError(error) {
        return error === REDIRECT_ERROR
          ? { kind: "redirect", location: "/about", statusCode: 307 }
          : null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    // The probe catches the TypeError but resolveSpecialError returns null
    // for it (TypeError is not a special error) so the probe returns null.
    // The redirect is never detected early.
    expect(result.response).toBeNull();
    expect(renderPageSpecialError).not.toHaveBeenCalled();
  });

  it("skips the page probe when a loading boundary is present (special errors handled post-shell)", async () => {
    // With a route-level loading.tsx Suspense boundary, the probe can't
    // catch a redirect()/notFound() thrown by the page without serializing
    // on the page promise — which would defeat loading.tsx's whole point.
    // Recovery instead happens later in renderAppPageLifecycle: the
    // rscErrorTracker captures the digest from React's onError, and a short
    // race window after shell-ready swaps the response to a 307/404 before
    // bytes are flushed.
    const probePage = vi.fn(() => new Promise<void>(() => {}));
    const renderPageSpecialError = vi.fn();

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: true,
      layoutCount: 0,
      probeLayoutAt() {
        throw new Error("should not probe layouts");
      },
      probePage,
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
      },
      renderPageSpecialError,
      resolveSpecialError() {
        throw new Error("should not be reached when the page probe is skipped");
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(probePage).not.toHaveBeenCalled();
    expect(renderPageSpecialError).not.toHaveBeenCalled();
    expect(result.response).toBeNull();
  });
});

// Regression coverage for https://github.com/cloudflare/vinext/issues/1235.
//
// The generated RSC entry originally hand-rolled the probePage() body and read
// a non-existent key off collectAppPageSearchParams's return value, so the
// page component received `undefined` for searchParams and any
// `await searchParams` threw TypeError during probing. probeAppPage()
// encapsulates that wiring so the entry can delegate to a single typed call
// and the behaviour is unit-testable in isolation.
describe("probeAppPage", () => {
  it("invokes the page with thenable params and resolved searchParams", async () => {
    const calls: { params: unknown; searchParams: unknown }[] = [];
    function Page(props: {
      params: Promise<Record<string, string>>;
      searchParams: Promise<Record<string, string | string[]>>;
    }) {
      calls.push({ params: props.params, searchParams: props.searchParams });
      return "rendered";
    }

    const asyncRouteParams = makeThenableParams({ slug: "intro" });
    const result = probeAppPage({
      pageComponent: Page,
      asyncRouteParams,
      searchParams: new URLSearchParams("id=abc&tag=hello&tag=world"),
    });

    expect(result).toBe("rendered");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toBe(asyncRouteParams);

    const sp = (await calls[0]?.searchParams) as Record<string, string | string[]>;
    expect(sp.id).toBe("abc");
    expect(sp.tag).toEqual(["hello", "world"]);
  });

  it("returns null when the page has no default export to render", () => {
    expect(
      probeAppPage({
        pageComponent: undefined,
        asyncRouteParams: makeThenableParams({}),
        searchParams: new URLSearchParams("id=abc"),
      }),
    ).toBeNull();
    expect(
      probeAppPage({
        pageComponent: null,
        asyncRouteParams: makeThenableParams({}),
        searchParams: null,
      }),
    ).toBeNull();
  });

  it("passes an empty searchParams object when the request has no query string", async () => {
    let received: Record<string, unknown> | undefined;
    async function Page(props: { searchParams: Promise<Record<string, unknown>> }) {
      received = await props.searchParams;
    }

    await probeAppPage({
      pageComponent: Page,
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
    });

    expect(received).toBeDefined();
    expect(Object.keys(received ?? {})).toEqual([]);
  });

  it("lets redirect()/notFound() throws propagate so the probe lifecycle can catch them", async () => {
    const REDIRECT = new Error("NEXT_REDIRECT");
    async function Page(props: { searchParams: Promise<{ dest?: string }> }) {
      const { dest } = await props.searchParams;
      if (dest) throw REDIRECT;
    }

    const result = probeAppPage({
      pageComponent: Page,
      asyncRouteParams: makeThenableParams({}),
      searchParams: new URLSearchParams("dest=/about"),
    }) as Promise<unknown>;

    await expect(result).rejects.toBe(REDIRECT);
  });
});
