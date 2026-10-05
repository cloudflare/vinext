import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageProbes,
  probeAppPage,
  probeAppPageBeforeRender,
  probeReactServerSubtree,
} from "../packages/vinext/src/server/app-page-probe.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
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

  it("handles layout special errors innermost first", async () => {
    const layoutError = new Error("layout failed");
    const renderLayoutSpecialError = vi.fn(
      async () => new Response("layout-fallback", { status: 404 }),
    );
    const probedLayouts: number[] = [];

    const result = await probeAppPageBeforeRender({
      layoutCount: 3,
      probeLayoutAt(layoutIndex) {
        probedLayouts.push(layoutIndex);
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      renderLayoutSpecialError,
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
    expect(renderLayoutSpecialError).toHaveBeenCalledWith(
      {
        kind: "http-access-fallback",
        statusCode: 404,
      },
      1,
    );
    expect(result.response?.status).toBe(404);
    await expect(result.response?.text()).resolves.toBe("layout-fallback");
  });

  it("leaves layout failures that are not special to the render", async () => {
    const layoutError = new Error("ordinary layout failure");
    const renderLayoutSpecialError = vi.fn();

    const result = await probeAppPageBeforeRender({
      layoutCount: 2,
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      renderLayoutSpecialError,
      resolveSpecialError() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(result.response).toBeNull();
    expect(renderLayoutSpecialError).not.toHaveBeenCalled();
  });

  it("propagates layoutFlags from layout probe result", async () => {
    const result = await probeAppPageBeforeRender({
      layoutCount: 2,
      probeLayoutAt() {
        return null;
      },
      renderLayoutSpecialError() {
        throw new Error("should not render a layout special error");
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
      layoutCount: 2,
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          throw layoutError;
        }
        return null;
      },
      renderLayoutSpecialError: vi.fn(async () => new Response("layout-fallback", { status: 404 })),
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
        },
      },
      pageComponent: recordingPage("page", probed),
      asyncRouteParams: makeThenableParams({ slug: "intro" }),
      searchParams: new URLSearchParams("q=hello"),
      intercept: { page: { default: recordingPage("intercept", probed) } },
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
      route: {},
      pageComponent: () => "page",
      asyncRouteParams: makeThenableParams({}),
      searchParams: null,
      intercept: { page: { default: InterceptPage } },
      isRscRequest: true,
      matchedParams: fallbackParams,
      makeThenableParams: makeThenableParamsLoose,
    });

    await Promise.all(probes);

    expect(receivedParams).toHaveLength(1);
    expect(await (receivedParams[0] as Promise<Record<string, unknown>>)).toEqual(fallbackParams);
  });
});
