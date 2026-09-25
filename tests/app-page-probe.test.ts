import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageInterceptSourceProbes,
  buildAppPageProbes,
  probeAppPage,
  probeAppPageBeforeRender,
  probeReactServerSubtree,
  resolveAppPageProbeIntercept,
} from "../packages/vinext/src/server/app-page-probe.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "../packages/vinext/src/server/app-rsc-route-matching.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
  markDynamicUsage,
} from "../packages/vinext/src/shims/headers.js";

// Mirrors makeThenableParams() from app-rsc-entry.ts — the function that
// converts raw null-prototype params into objects that work with both
// `await params` (Next.js 15+) and `params.id` (pre-15).
function makeThenableParams<T extends Record<string, unknown>>(obj: T): Promise<T> & T {
  const plain = { ...obj } as T;
  return Object.assign(Promise.resolve(plain), plain);
}

async function registerCachedProbePage<TProps extends Record<string, unknown>, TResult>(
  fn: (props: TProps) => Promise<TResult>,
  id: string,
): Promise<(props: TProps) => Promise<TResult>> {
  const { registerCachedFunction } = await import("../packages/vinext/src/shims/cache-runtime.js");
  const { MemoryCacheHandler, setCacheHandler } =
    await import("../packages/vinext/src/shims/cache.js");
  setCacheHandler(new MemoryCacheHandler());
  consumeDynamicUsage();
  consumeRenderRequestApiUsage();
  return registerCachedFunction(fn, id);
}

describe("app page probe helpers", () => {
  it("probes server components returned below a layout result", async () => {
    const calls: string[] = [];

    function Child() {
      calls.push("child");
      return null;
    }

    function Layout() {
      calls.push("layout");
      return React.createElement("section", null, React.createElement(Child));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "child"]);
  });

  it("does not invoke client references returned below a layout result", async () => {
    const ClientReference = Object.assign(
      vi.fn(() => {
        throw new Error("client reference must not execute on the server");
      }),
      { $$typeof: Symbol.for("react.client.reference") },
    );

    function Layout() {
      return React.createElement("section", null, React.createElement(ClientReference));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(ClientReference).not.toHaveBeenCalled();
  });

  it("probes memo and forwardRef server components returned below a layout result", async () => {
    const calls: string[] = [];

    const MemoChild = React.memo(function MemoChild() {
      calls.push("memo");
      return null;
    });
    const ForwardRefChild = React.forwardRef(function ForwardRefChild() {
      calls.push("forwardRef");
      return null;
    });
    const MemoForwardRefChild = React.memo(
      React.forwardRef(function MemoForwardRefChild() {
        calls.push("memoForwardRef");
        return null;
      }),
    );

    function Layout() {
      calls.push("layout");
      return React.createElement(
        "section",
        null,
        React.createElement(MemoChild),
        React.createElement(ForwardRefChild),
        React.createElement(MemoForwardRefChild),
      );
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "memo", "forwardRef", "memoForwardRef"]);
  });

  it("probes lazy server components returned below a layout result", async () => {
    const calls: string[] = [];

    const LazyChild = React.lazy(() =>
      Promise.resolve({
        default() {
          calls.push("lazy");
          return null;
        },
      }),
    );

    function Layout() {
      calls.push("layout");
      return React.createElement("section", null, React.createElement(LazyChild));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "lazy"]);
  });

  it("enforces subtree depth limits for nested arrays", async () => {
    await expect(
      probeReactServerSubtree([[[React.createElement("span")]]], { maxDepth: 1 }),
    ).rejects.toThrow("App page layout subtree probe exceeded max depth");
  });

  it("enforces subtree node limits for large arrays", async () => {
    await expect(probeReactServerSubtree([1, 2, 3], { maxNodes: 2 })).rejects.toThrow(
      "App page layout subtree probe exceeded max nodes",
    );
  });

  it("does not consume single-use iterables while probing layout children", async () => {
    function Child() {
      return null;
    }

    function* createChildren() {
      yield React.createElement(Child);
    }

    const sharedChildren = createChildren();

    function Layout() {
      return React.createElement("section", null, sharedChildren);
    }

    await expect(probeReactServerSubtree(React.createElement(Layout))).rejects.toThrow(
      "App page layout subtree probe cannot safely inspect iterable children",
    );
    expect(sharedChildren.next().value).toMatchObject({ type: Child });
  });

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
        async runWithIsolatedDynamicScope(fn) {
          return { result: await fn(), dynamicDetected: false };
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
        async runWithIsolatedDynamicScope(fn) {
          return { result: await fn(), dynamicDetected: false };
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

  it("skips the page probe when disabled for document rendering", async () => {
    const probePage = vi.fn(() => {
      throw new Error("page probe should not execute");
    });
    const renderPageSpecialError = vi.fn();

    const result = await probeAppPageBeforeRender({
      hasLoadingBoundary: false,
      probePageBeforeRender: false,
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

  it("does not mark dynamic when a cached page probe only derives its cache key", async () => {
    const CachedPage = await registerCachedProbePage(
      async (props: {
        params: Promise<{ slug: string }>;
        searchParams: Promise<Record<string, unknown>>;
      }) => {
        const params = await props.params;
        return `slug:${params.slug}`;
      },
      "test:probe-page-props-searchparams-inert",
    );

    await probeAppPage({
      pageComponent: CachedPage,
      asyncRouteParams: makeThenableParams({ slug: "intro" }),
      searchParams: new URLSearchParams("q=hello"),
    });

    expect(consumeDynamicUsage()).toBe(false);
    expect(consumeRenderRequestApiUsage()).toEqual([]);
  });

  it("rejects when a cached page probe awaits searchParams in the page body", async () => {
    const CachedPage = await registerCachedProbePage(
      async (props: { searchParams: Promise<{ q?: string }> }) => {
        const searchParams = await props.searchParams;
        return searchParams.q ?? "";
      },
      "test:probe-page-props-searchparams-observed",
    );

    await expect(
      probeAppPage({
        pageComponent: CachedPage,
        asyncRouteParams: makeThenableParams({}),
        searchParams: new URLSearchParams("q=hello"),
      }),
    ).rejects.toThrow(/cannot be called inside "use cache"/);
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

// buildAppPageProbes() fans out the per-request page probes (matched page +
// active parallel slots + interception page). Extracted out of the generated
// RSC entry so the fan-out is unit-testable (AGENTS.md: keep generated entries
// thin). These tests pin which page components get probed for a request.
describe("buildAppPageProbes", () => {
  // Loosely-typed adapter matching the helper's `(params: unknown) => unknown`
  // signature, so the test's generic makeThenableParams can be passed in.
  const makeThenableParamsLoose = (params: unknown): unknown =>
    makeThenableParams((params ?? {}) as Record<string, unknown>);

  function recordingPage(label: string, sink: string[]) {
    return function Page(props: { searchParams: Promise<Record<string, unknown>> }) {
      void props;
      sink.push(label);
      return label;
    };
  }

  it("probes the matched page, every slot page, and the interception page", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          modal: { page: { default: recordingPage("modal", probed) } },
          sidebar: { page: { default: recordingPage("sidebar", probed) } },
          photos: {},
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({ slug: "intro" }),
      searchParams: new URLSearchParams("q=hello"),
      intercept: { page: { default: recordingPage("intercept", probed) }, slotKey: "photos" },
      isRscRequest: true,
      matchedParams: { slug: "intro" },
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probes).toHaveLength(4);
    expect(probed.sort()).toEqual(["intercept", "modal", "page", "sidebar"]);
  });

  it("ignores the interception match for non-RSC (HTML) requests", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          // On an HTML request interception never fires, so the modal slot
          // renders its own page and must be probed; the interception page
          // (which never renders) must NOT be probed.
          modal: { page: { default: recordingPage("modal", probed) } },
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: new URLSearchParams("q=hello"),
      intercept: {
        slotKey: "modal",
        page: { default: recordingPage("intercept", probed) },
      },
      isRscRequest: false,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probed.sort()).toEqual(["modal", "page"]);
    expect(probed).not.toContain("intercept");
  });

  it("probes the interception page in place of the slot it overrides", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          // modal slot is overridden by the active interception below, so its
          // own page must NOT be probed (it never renders for this request).
          modal: { page: { default: recordingPage("modal-page", probed) } },
          sidebar: { page: { default: recordingPage("sidebar", probed) } },
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: new URLSearchParams("q=hello"),
      intercept: {
        slotKey: "modal",
        page: { default: recordingPage("intercept", probed) },
      },
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    // modal-page is skipped (overridden); intercept renders in its place.
    expect(probed.sort()).toEqual(["intercept", "page", "sidebar"]);
    expect(probed).not.toContain("modal-page");
  });

  it("omits the probe of a slot intercept the route has no slot for", async () => {
    // A route-group variant of the source without @modal renders unchanged,
    // so the intercepting page never renders and must not bail it out.
    const probed: string[] = [];
    const route = { slots: { sidebar: { page: { default: recordingPage("sidebar", probed) } } } };
    const intercept = { slotKey: "modal", page: { default: recordingPage("intercept", probed) } };
    const probes = buildAppPageProbes({
      route,
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: new URLSearchParams("q=hello"),
      intercept,
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probed.sort()).toEqual(["page", "sidebar"]);
    expect(resolveAppPageProbeIntercept(route, intercept)).toBeNull();
    expect(resolveAppPageProbeIntercept({ slots: { modal: {} } }, intercept)).toBe(intercept);
    const siblingIntercept = { ...intercept, slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY };
    expect(resolveAppPageProbeIntercept(route, siblingIntercept)).toBe(siblingIntercept);
  });

  it("omits the interception probe when no interception matches", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: { slots: { modal: { page: { default: recordingPage("modal", probed) } } } },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      intercept: null,
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probes).toHaveLength(2);
    expect(probed.sort()).toEqual(["modal", "page"]);
  });

  it("does not await slot pages protected by branch-local loading boundaries", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          modal: {
            loading: { default: () => "loading" },
            page: { default: recordingPage("modal", probed) },
          },
          sidebar: {
            loadings: [{ default: () => "loading" }],
            page: { default: recordingPage("sidebar", probed) },
          },
          team: { page: { default: recordingPage("team", probed) } },
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probed.sort()).toEqual(["page", "team"]);
  });

  it("does not await intercepted pages protected by slot or intercept loading boundaries", async () => {
    const probed: string[] = [];
    const buildProbes = (interceptLoadings?: readonly { default?: unknown }[]) =>
      buildAppPageProbes({
        route: {
          slots: {
            modal: {
              loading: interceptLoadings ? null : { default: () => "slot loading" },
              page: { default: recordingPage("modal", probed) },
            },
          },
        },
        pageComponent: recordingPage("page", probed),
        asyncRouteParams: makeThenableParams({}),
        searchParams: null,
        intercept: {
          interceptLoadings,
          page: { default: recordingPage("intercept", probed) },
          slotKey: "modal",
        },
        isRscRequest: true,
        matchedParams: {},
        makeThenableParams: makeThenableParamsLoose,
      });

    await Promise.all(buildProbes([{ default: () => "intercept loading" }]));
    await Promise.all(buildProbes());

    expect(probed).toEqual(["page", "page"]);
  });

  it("does await intercepted pages when only a sibling normal branch has loading", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          modal: {
            loadings: [{ default: () => "gallery loading" }],
            loadingTreePositions: [1],
            page: { default: recordingPage("gallery", probed) },
          },
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      intercept: {
        page: { default: recordingPage("intercept", probed) },
        slotKey: "modal",
      },
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probed.sort()).toEqual(["intercept", "page"]);
  });

  it("skips slots without a page default export", async () => {
    const probed: string[] = [];
    const probes = buildAppPageProbes({
      route: {
        slots: {
          modal: { page: { default: recordingPage("modal", probed) } },
          // default-only slot: no page component to probe
          children: { page: null },
          empty: null,
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    // One probe per slot is created, but only real page components run.
    expect(probed.sort()).toEqual(["modal", "page"]);
  });

  it("falls back to matchedParams when an interception match omits its own params", async () => {
    const receivedParams: unknown[] = [];
    function InterceptPage(props: { params: Promise<Record<string, unknown>> }) {
      receivedParams.push(props.params);
      return "intercept";
    }

    const fallbackParams = { username: "ada" };
    const probes = buildAppPageProbes({
      route: { slots: { modal: {} } },
      pageComponent: () => "page",
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      intercept: { page: { default: InterceptPage }, slotKey: "modal" },
      isRscRequest: true,
      matchedParams: fallbackParams,
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(receivedParams).toHaveLength(1);
    expect(await (receivedParams[0] as Promise<Record<string, unknown>>)).toEqual(fallbackParams);
  });

  // app/feed/page.tsx with app/feed/(.)photos/[id]/page.tsx
  it("probes a sibling-page intercept's page in place of the source page", async () => {
    const probed: string[] = [];
    const probe = (sourceIsDynamic: boolean) =>
      buildAppPageProbes({
        route: {},
        pageComponent: function Page() {
          probed.push("page");
          // Stands in for headers() or cookies().
          if (sourceIsDynamic) markDynamicUsage();
          return "page";
        },
        asyncRouteParams: makeThenableParams({}),
        searchParams: null,
        intercept: {
          page: {
            default: function Photo() {
              probed.push("intercept");
              if (!sourceIsDynamic) markDynamicUsage();
              return "intercept";
            },
          },
          slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
        },
        isRscRequest: true,
        matchedParams: {},
        makeThenableParams: makeThenableParamsLoose,
      });
    consumeDynamicUsage();

    await Promise.all(probe(true));
    expect(consumeDynamicUsage()).toBe(false);
    await Promise.all(probe(false));
    expect(consumeDynamicUsage()).toBe(true);
    expect(probed).toEqual(["intercept", "intercept"]);
  });

  // A route-group variant of the source without app/feed/@modal.
  it("does not probe an interception for a slot the route doesn't have", async () => {
    const probed: string[] = [];
    consumeDynamicUsage();
    const probes = buildAppPageProbes({
      route: { slots: { sidebar: { page: { default: recordingPage("sidebar", probed) } } } },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      intercept: {
        page: {
          default: function Photo() {
            probed.push("intercept");
            markDynamicUsage();
            return "intercept";
          },
        },
        slotKey: "modal",
      },
      isRscRequest: true,
      matchedParams: {},
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(probed.sort()).toEqual(["page", "sidebar"]);
    expect(consumeDynamicUsage()).toBe(false);
  });
});

// buildAppPageInterceptSourceProbes() runs, ahead of a direct intercepted RSC
// response's headers, what that response's render includes before any loading
// boundary.
describe("buildAppPageInterceptSourceProbes", () => {
  const makeThenableParamsLoose = (params: unknown): unknown =>
    makeThenableParams((params ?? {}) as Record<string, unknown>);

  // A layout, template, page or default that records its render and, when
  // `dynamic`, stands in for a headers() or cookies() call.
  function recording(label: string, sink: string[], dynamic = false) {
    return function Component(props: { children?: React.ReactNode }) {
      sink.push(label);
      if (dynamic) markDynamicUsage();
      return props.children ?? label;
    };
  }

  // A component that awaits forever; awaiting its probe would hold the
  // response headers.
  function neverSettling(label: string, sink: string[]) {
    return function Component(): Promise<React.ReactNode> {
      sink.push(label);
      markDynamicUsage();
      return new Promise(() => {});
    };
  }

  function probeSource(
    options: Partial<Parameters<typeof buildAppPageInterceptSourceProbes>[0]> &
      Pick<Parameters<typeof buildAppPageInterceptSourceProbes>[0], "route">,
  ): Promise<void[]> {
    consumeDynamicUsage();
    return Promise.all(
      buildAppPageInterceptSourceProbes({
        pageComponent: undefined,
        sourceParams: {},
        searchParams: null,
        mountedSlotsHeader: null,
        renderMode: undefined,
        makeThenableParams: makeThenableParamsLoose,
        ...options,
      }),
    );
  }

  const modalIntercept = (sink: string[]) => ({
    page: { default: recording("intercept", sink) },
    slotKey: "modal",
  });

  it("probes the intercepted slot's layout and the intercepting branch's layouts", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        slots: {
          modal: { layout: { default: recording("modal", probed) } },
          // Its layout wraps only a page it doesn't have.
          sidebar: { layout: { default: recording("sidebar", probed) } },
        },
      },
      intercept: {
        ...modalIntercept(probed),
        interceptLayouts: [{ default: recording("photos", probed) }, null],
        matchedParams: { id: "123" },
      },
    });

    expect(probed).toEqual(["modal", "photos", "intercept"]);
  });

  it("records an intercepting layout's dynamic API read", async () => {
    const probed: string[] = [];
    await probeSource({
      route: { slots: { modal: {} } },
      intercept: {
        ...modalIntercept(probed),
        interceptLayouts: [{ default: recording("photos", probed, true) }],
      },
    });

    expect(consumeDynamicUsage()).toBe(true);
  });

  // app/feed/template.tsx
  it("probes the source's templates", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [{ default: recording("layout", probed) }],
        layoutTreePositions: [1],
        routeSegments: ["feed"],
        templates: [{ default: recording("template", probed, true) }],
        templateTreePositions: [1],
      },
      pageComponent: recording("page", probed),
    });

    expect(probed).toEqual(["layout", "template", "page"]);
    expect(consumeDynamicUsage()).toBe(true);
  });

  // app/feed/loading.tsx above app/feed/[id]/template.tsx
  it("stops the source's layouts and templates at its loading boundary", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [{ default: recording("feed", probed) }, { default: neverSettling("id", probed) }],
        layoutTreePositions: [1, 2],
        loadings: [{ default: () => null }],
        loadingTreePositions: [1],
        routeSegments: ["feed", "[id]"],
        templates: [
          { default: recording("feed-template", probed) },
          { default: neverSettling("id-template", probed) },
        ],
        templateTreePositions: [1, 2],
      },
      pageComponent: neverSettling("page", probed),
    });

    expect(probed).toEqual(["feed", "feed-template"]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  // app/feed/@sidebar/layout.tsx and app/feed/@sidebar/settings/layout.tsx
  it("probes an ordinary slot's layout chain", async () => {
    const probed: string[] = [];
    const received: Record<string, unknown>[] = [];
    await probeSource({
      route: {
        layoutTreePositions: [0, 2],
        routeSegments: ["[team]", "feed"],
        slots: {
          modal: {},
          sidebar: {
            configLayouts: [
              {
                default: async function SettingsLayout(props: {
                  params: Promise<Record<string, unknown>>;
                }) {
                  received.push({ ...(await props.params) });
                  probed.push("settings");
                  return null;
                },
              },
            ],
            configLayoutTreePositions: [1],
            layout: { default: recording("sidebar", probed, true) },
            layoutIndex: 1,
            name: "sidebar",
            page: { default: recording("sidebar-page", probed) },
            routeSegments: ["settings"],
          },
        },
      },
      intercept: modalIntercept(probed),
      sourceParams: { team: "acme" },
    });

    expect(probed.sort()).toEqual(["intercept", "settings", "sidebar", "sidebar-page"]);
    expect(received).toEqual([{ team: "acme" }]);
    expect(consumeDynamicUsage()).toBe(true);
  });

  // app/feed/@sidebar/settings/loading.tsx
  it("stops an ordinary slot's layout chain at its loading boundary", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        slots: {
          sidebar: {
            configLayouts: [
              { default: recording("settings", probed) },
              { default: neverSettling("advanced", probed) },
            ],
            configLayoutTreePositions: [1, 2],
            layout: { default: recording("sidebar", probed) },
            loadings: [{ default: () => null }],
            loadingTreePositions: [1],
            page: { default: neverSettling("sidebar-page", probed) },
          },
        },
      },
    });

    expect(probed.sort()).toEqual(["settings", "sidebar"]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  it("probes a slot's default where route wiring renders it", async () => {
    const probed: string[] = [];
    const defaultOnly = (name: string, extra: Record<string, unknown> = {}) => ({
      default: { default: recording(name, probed) },
      // Its layout wraps only a page, not its default.
      layout: { default: recording(`${name}-layout`, probed) },
      layoutIndex: 1,
      name,
      ...extra,
    });
    const probe = (mountedSlotsHeader: string | null) =>
      probeSource({
        route: {
          layoutTreePositions: [0, 1],
          routeSegments: ["feed"],
          slots: {
            // Its page renders, not its default.
            analytics: {
              ...defaultOnly("analytics-default"),
              page: { default: recording("analytics", probed) },
            },
            // Replaced by the interception.
            modal: defaultOnly("modal"),
            sidebar: defaultOnly("sidebar"),
            // Behind its loading boundary.
            team: defaultOnly("team", { loading: { default: () => "loading" } }),
          },
        },
        pageComponent: recording("page", probed),
        intercept: modalIntercept(probed),
        mountedSlotsHeader,
      });

    await probe(null);
    expect(probed.splice(0).sort()).toEqual([
      "analytics",
      "analytics-default-layout",
      "intercept",
      "modal-layout",
      "page",
      "sidebar",
    ]);
    // The client keeps app/feed/@sidebar mounted, so the payload omits it.
    await probe("slot:sidebar:/feed");
    expect(probed.splice(0).sort()).toEqual([
      "analytics",
      "analytics-default-layout",
      "intercept",
      "modal-layout",
      "page",
    ]);
  });

  it("probes nothing for a prefetch-empty render", async () => {
    const probed: string[] = [];
    const probes = buildAppPageInterceptSourceProbes({
      route: {
        layouts: [{ default: recording("layout", probed, true) }],
        slots: {
          modal: {},
          // Its default reads a dynamic API and never settles.
          sidebar: { default: { default: neverSettling("sidebar", probed) }, name: "sidebar" },
        },
      },
      pageComponent: recording("page", probed, true),
      intercept: modalIntercept(probed),
      sourceParams: {},
      searchParams: null,
      mountedSlotsHeader: null,
      renderMode: "prefetch-empty",
      makeThenableParams: makeThenableParamsLoose,
    });
    consumeDynamicUsage();

    await Promise.all(probes);

    expect(probes).toEqual([]);
    expect(probed).toEqual([]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  // app/feed/@team/loading.tsx, with app/feed/@sidebar/default.tsx
  it("probes only what a loading-shell prefetch renders", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [{ default: recording("layout", probed) }],
        layoutTreePositions: [0],
        slots: {
          // The shell renders only branches with a loading boundary.
          sidebar: { default: { default: neverSettling("sidebar", probed) }, name: "sidebar" },
          team: {
            layout: { default: recording("team-layout", probed) },
            loading: { default: () => null },
            name: "team",
            page: { default: neverSettling("team-page", probed) },
          },
        },
      },
      // The shell omits the page.
      pageComponent: neverSettling("page", probed),
      renderMode: "prefetch-loading-shell",
    });

    expect(probed.sort()).toEqual(["layout", "team-layout"]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  // app/feed/@team/loading.tsx, where app/feed/layout.tsx owns app/feed/@team
  it("probes no layout below a loading-shell prefetch's cutoff", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [
          { default: recording("root", probed) },
          { default: recording("feed", probed) },
          { default: neverSettling("id", probed) },
        ],
        layoutTreePositions: [0, 1, 2],
        routeSegments: ["feed", "[id]"],
        slots: {
          team: {
            layout: { default: recording("team-layout", probed) },
            layoutIndex: 1,
            loading: { default: () => null },
            name: "team",
            ownerTreePosition: 1,
            page: { default: neverSettling("team-page", probed) },
          },
        },
      },
      renderMode: "prefetch-loading-shell",
    });

    // The shell stops at the deepest owner of a slot loading boundary.
    expect(probed.sort()).toEqual(["feed", "root", "team-layout"]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  // app/loading.tsx and app/feed/[id]/loading.tsx
  it("probes the route loading component a loading-shell prefetch renders", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [
          { default: recording("root", probed) },
          { default: recording("feed", probed) },
          { default: recording("id", probed) },
        ],
        layoutTreePositions: [0, 1, 2],
        loadings: [
          { default: recording("root-loading", probed) },
          { default: recording("id-loading", probed, true) },
        ],
        loadingTreePositions: [0, 2],
        routeSegments: ["feed", "[id]"],
      },
      pageComponent: neverSettling("page", probed),
      renderMode: "prefetch-loading-shell",
    });

    // The shell renders the first loading UI below the root, with no
    // Suspense boundary for the root's, so every layout above it renders.
    expect(probed.sort()).toEqual(["feed", "id", "id-loading", "root"]);
    expect(consumeDynamicUsage()).toBe(true);
  });

  // app/feed/@team/loading.tsx
  it("probes the slot loading component a loading-shell prefetch renders", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        layouts: [{ default: recording("layout", probed) }],
        layoutTreePositions: [0],
        slots: {
          modal: {},
          team: {
            layout: { default: recording("team-layout", probed) },
            loading: { default: recording("team-loading", probed, true) },
            name: "team",
            page: { default: neverSettling("team-page", probed) },
          },
        },
      },
      intercept: modalIntercept(probed),
      renderMode: "prefetch-loading-shell",
    });

    expect(probed.sort()).toEqual(["layout", "team-layout", "team-loading"]);
    expect(consumeDynamicUsage()).toBe(true);
  });

  // app/[team]/feed/@modal/(.)photos/layout.tsx and
  // app/[team]/feed/@modal/(.)photos/[id]/layout.tsx
  it("passes each layout the params its place in the intercepted tree sees", async () => {
    const received: [string, Record<string, unknown>][] = [];
    const paramsLayout = (label: string, readsHeadersWithId = false) =>
      async function Layout(props: {
        children?: React.ReactNode;
        params: Promise<Record<string, unknown>>;
      }) {
        const params = await props.params;
        received.push([label, { ...params }]);
        // Stands in for a headers() call that only a child param triggers.
        if (readsHeadersWithId && params.id) markDynamicUsage();
        return props.children;
      };

    await probeSource({
      route: {
        layoutTreePositions: [0, 2],
        routeSegments: ["[team]", "feed"],
        slots: { modal: { layout: { default: paramsLayout("modal") }, layoutIndex: 1 } },
      },
      intercept: {
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptLayouts: [
          { default: paramsLayout("photos", true) },
          { default: paramsLayout("photo") },
        ],
        interceptLayoutSegments: [["(.)photos"], ["(.)photos", "[id]"]],
        matchedParams: { id: "123", team: "acme" },
        page: { default: () => null },
        slotKey: "modal",
      },
      sourceParams: { team: "acme" },
    });

    expect(received).toEqual([
      ["modal", { team: "acme" }],
      ["photos", { team: "acme" }],
      ["photo", { id: "123", team: "acme" }],
    ]);
    expect(consumeDynamicUsage()).toBe(false);
  });

  // app/[team]/(.)photos/layout.tsx and app/[team]/(.)photos/[id]/layout.tsx
  it("passes a sibling-page intercept's layouts the params their segments see", async () => {
    const received: [string, Record<string, unknown>][] = [];
    const paramsLayout = (label: string) =>
      async function Layout(props: {
        children?: React.ReactNode;
        params: Promise<Record<string, unknown>>;
      }) {
        received.push([label, { ...(await props.params) }]);
        return props.children;
      };

    await probeSource({
      route: { routeSegments: ["[team]", "feed"] },
      intercept: {
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptLayouts: [{ default: paramsLayout("photos") }, { default: paramsLayout("photo") }],
        interceptLayoutSegments: [["(.)photos"], ["(.)photos", "[id]"]],
        matchedParams: { id: "123", team: "acme" },
        slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
      },
      sourceParams: { team: "acme" },
    });

    expect(received).toEqual([
      ["photos", { team: "acme" }],
      ["photo", { id: "123", team: "acme" }],
    ]);
  });

  // app/feed/@modal/(.)photos/loading.tsx above
  // app/feed/@modal/(.)photos/[id]/layout.tsx
  it("stops at an intercepting loading boundary", async () => {
    const probed: string[] = [];
    await probeSource({
      route: { slots: { modal: { layout: { default: recording("modal", probed) } } } },
      intercept: {
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptLayouts: [
          { default: recording("photos", probed) },
          { default: neverSettling("photo", probed) },
        ],
        interceptLayoutSegments: [["(.)photos"], ["(.)photos", "[id]"]],
        interceptLoadings: [{ default: () => null }],
        interceptLoadingTreePositions: [1],
        matchedParams: { id: "123" },
        page: { default: neverSettling("intercept", probed) },
        slotKey: "modal",
      },
    });

    expect(probed).toEqual(["modal", "photos"]);
  });

  it("stops below the intercepted slot's root loading boundary", async () => {
    const probed: string[] = [];
    await probeSource({
      route: {
        slots: {
          modal: {
            layout: { default: recording("modal", probed) },
            loading: { default: () => null },
          },
        },
      },
      intercept: {
        interceptBranchSegments: ["(.)photos"],
        interceptLayouts: [{ default: neverSettling("photos", probed) }],
        interceptLayoutSegments: [["(.)photos"]],
        page: { default: neverSettling("intercept", probed) },
        slotKey: "modal",
      },
    });

    expect(probed).toEqual(["modal"]);
  });

  it("probes no slot inside a source loading boundary", async () => {
    const probed: string[] = [];
    const probe = (slotKey: string, loadingTreePosition: number) =>
      probeSource({
        route: {
          layoutTreePositions: [0, 1],
          loadings: [{ default: () => null }],
          loadingTreePositions: [loadingTreePosition],
          routeSegments: ["feed", "[id]"],
          slots: { modal: { layout: { default: recording("modal", probed) }, layoutIndex: 1 } },
        },
        intercept: {
          interceptLayouts: [{ default: recording("photos", probed) }],
          interceptLayoutSegments: [["(.)photos"]],
          page: { default: () => null },
          slotKey,
        },
      });

    // app/feed/loading.tsx wraps the slot that app/feed/layout.tsx owns.
    await probe("modal", 1);
    expect(probed.splice(0)).toEqual([]);
    // A sibling-page intercept renders in place of the source's page.
    await probe(SIBLING_PAGE_INTERCEPT_SLOT_KEY, 2);
    expect(probed.splice(0)).toEqual([]);
    // A loading boundary below the slot's owner doesn't wrap the slot.
    await probe("modal", 2);
    expect(probed.splice(0)).toEqual(["modal", "photos"]);
  });

  // A route-group variant of the source without app/feed/@modal.
  it("probes no interception for a slot the route doesn't have", async () => {
    const probed: string[] = [];
    await probeSource({
      route: { slots: { sidebar: { page: { default: recording("sidebar", probed) } } } },
      intercept: {
        interceptLayouts: [{ default: recording("photos", probed) }],
        page: { default: recording("intercept", probed, true) },
        slotKey: "modal",
      },
      pageComponent: recording("page", probed),
    });

    expect(probed.sort()).toEqual(["page", "sidebar"]);
    expect(consumeDynamicUsage()).toBe(false);
  });
});
