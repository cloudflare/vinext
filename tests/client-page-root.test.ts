import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeClientPageSsrSearchParamsThenable } from "../packages/vinext/src/server/app-page-search-params-observation.js";
import { startCandidateSearchParamsGate } from "../packages/vinext/src/server/app-ssr-search-params-gate.js";
import {
  ClientPageRoot,
  createClientPageSearchParams,
} from "../packages/vinext/src/shims/client-page-root.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
  headersContextFromRequest,
  isRenderDynamicLatched,
  runWithHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { setNavigationContext, useSearchParams } from "../packages/vinext/src/shims/navigation.js";

type SearchParamsProps = { searchParams: Promise<Record<string, string | string[]>> };

function ReadingPage({ searchParams }: SearchParamsProps): React.ReactNode {
  const { q } = React.use(searchParams);
  return React.createElement("p", null, `page:${String(q)}`);
}

function IgnoringPage(): React.ReactNode {
  return React.createElement("p", null, "page:static");
}

function SyncReadingPage({ searchParams }: SearchParamsProps): React.ReactNode {
  return React.createElement("p", null, `page:${String(Reflect.get(searchParams, "q"))}`);
}

function SearchValue(): React.ReactNode {
  return React.createElement("p", null, `hook:${useSearchParams().get("q") ?? ""}`);
}

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithHeadersContext(
    headersContextFromRequest(new Request("https://example.test/client?q=secret")),
    fn,
  );
}

/** Set up SSR navigation state as handleSsr does for a candidate render. */
function startCandidateSsr(options?: { isPprFallbackShell?: boolean }) {
  const searchParams = new URLSearchParams("q=secret");
  const gate = startCandidateSearchParamsGate();
  setNavigationContext({
    pathname: "/client",
    searchParams,
    params: {},
    searchParamsGate: gate.gate,
    clientPageSearchParams: makeClientPageSsrSearchParamsThenable(searchParams, {
      isPprFallbackShell: options?.isPprFallbackShell,
    }),
  });
  return gate;
}

async function renderPage(
  Component: React.ComponentType<SearchParamsProps>,
  extra?: React.ReactNode,
  rootProps?: { emptySearchParams?: boolean },
): Promise<string> {
  const stream = await renderToReadableStream(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ClientPageRoot, {
        Component: Component as React.ComponentType<Record<string, unknown>>,
        pageProps: { params: Promise.resolve({}) },
        ...rootProps,
      }),
      extra,
    ),
    { onError: () => {} },
  );
  await stream.allReady;
  return new Response(stream).text();
}

/**
 * Render to HTML once everything settles. A page suspends the first time it
 * uses a searchParams promise React hasn't tracked yet.
 */
async function renderMarkup(element: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

afterEach(() => {
  setNavigationContext(null);
});

describe("ClientPageRoot in SSR", () => {
  it("marks a candidate render dynamic when the page reads searchParams", async () => {
    await inRequest(async () => {
      const gate = startCandidateSsr();
      const html = await renderPage(
        ReadingPage,
        React.createElement(
          React.Suspense,
          { fallback: React.createElement("p", null, "fallback") },
          React.createElement(SearchValue),
        ),
      );

      // The read is a dynamic API, so the render won't be stored and the
      // page and useSearchParams() both render the real query.
      expect(html).toContain("page:secret");
      expect(html).toContain("hook:secret");
      expect(gate.gate.decision).toBe("real");
      expect(isRenderDynamicLatched()).toBe(true);
      expect(consumeDynamicUsage()).toBe(true);
      expect(consumeRenderRequestApiUsage()).toContain("searchParams");
    });
  });

  it("marks a synchronous property read dynamic and returns the real value", async () => {
    await inRequest(async () => {
      startCandidateSsr();
      const html = await renderPage(SyncReadingPage);

      expect(html).toContain("page:secret");
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("leaves a candidate render static when the page never reads searchParams", async () => {
    await inRequest(async () => {
      const gate = startCandidateSsr();
      const html = await renderPage(IgnoringPage);

      expect(html).toContain("page:static");
      expect(html).not.toContain("secret");
      expect(gate.gate.decision).toBeNull();
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeDynamicUsage()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("hands a force-static page an empty, untracked query", async () => {
    await inRequest(async () => {
      startCandidateSsr();
      const html = await renderPage(ReadingPage, null, { emptySearchParams: true });

      expect(html).toContain("page:undefined");
      expect(html).not.toContain("secret");
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("hands a PPR fallback shell its query untracked", async () => {
    await inRequest(async () => {
      startCandidateSsr({ isPprFallbackShell: true });
      const html = await renderPage(ReadingPage);

      expect(html).toContain("page:secret");
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("observes a force-static navigation context's query untracked", async () => {
    // handleSsr's own force-static guard, behind the page's emptySearchParams.
    await inRequest(async () => {
      const searchParams = makeClientPageSsrSearchParamsThenable(new URLSearchParams(), {
        isForceStatic: true,
      });

      expect({ ...(await searchParams) }).toEqual({});
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("marks a direct own-property check dynamic and answers it like the browser", async () => {
    await inRequest(async () => {
      startCandidateSsr();
      function OwnPropertyPage({ searchParams }: SearchParamsProps): React.ReactNode {
        return React.createElement("p", null, `own:${String(searchParams.hasOwnProperty("q"))}`);
      }
      const html = await renderPage(OwnPropertyPage);

      expect(html).toContain("own:true");
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("keeps handing the page the same promise across renders", async () => {
    await inRequest(async () => {
      startCandidateSsr();
      const received: unknown[] = [];
      function RecordingPage({ searchParams }: SearchParamsProps): React.ReactNode {
        received.push(searchParams);
        return null;
      }
      await renderPage(RecordingPage);
      await renderPage(RecordingPage);

      expect(received).toHaveLength(2);
      expect(received[0]).toBe(received[1]);
    });
  });
});

describe("createClientPageSearchParams", () => {
  it("builds a settled promise with the query readable synchronously", async () => {
    const searchParams = createClientPageSearchParams(
      new URLSearchParams("q=one&tag=a&tag=b&status=y&value=z&then=x"),
    );
    const record = await searchParams;

    // Reserved names aren't query keys, and React adds its bookkeeping only
    // once it tracks the promise, as it does with the SSR thenable.
    expect(Reflect.get(searchParams, "status")).toBeUndefined();
    expect(Reflect.get(searchParams, "value")).toBeUndefined();
    expect(Reflect.get(searchParams, "q")).toBe("one");
    expect(Reflect.get(searchParams, "tag")).toEqual(["a", "b"]);
    // Names Promise and React rely on keep their meaning, and stay readable
    // once awaited.
    expect(typeof searchParams.then).toBe("function");
    expect(Reflect.get(record, "then")).toBe("x");
    expect(Reflect.get(record, "status")).toBe("y");
    expect(Reflect.get(record, "value")).toBe("z");
    expect(Object.keys(record)).toEqual(["q", "tag", "status", "value", "then"]);
  });

  it("builds an empty record without a query", async () => {
    expect({ ...(await createClientPageSearchParams(null)) }).toEqual({});
  });

  it("enumerates like the SSR thenable, so hydration sees the same keys", async () => {
    const query = "q=one&status=y&value=z&then=x&constructor=c&tag=a&tag=b";
    const browser = createClientPageSearchParams(new URLSearchParams(query));
    const ssr = makeClientPageSsrSearchParamsThenable(new URLSearchParams(query), {
      isPprFallbackShell: true,
    });

    // React's bookkeeping and the reserved names aren't query keys.
    expect(Object.keys(browser)).toEqual(["q", "constructor", "tag"]);
    expect(Object.keys(browser)).toEqual(Object.keys(ssr));
    // What `{ ...searchParams }` copies.
    expect(Object.entries(browser)).toEqual(Object.entries(ssr));
    expect({ ...(await browser) }).toEqual({ ...(await ssr) });
  });

  it("answers direct own-property checks like the SSR thenable", async () => {
    const query = "q=one&then=x";
    const browser = createClientPageSearchParams(new URLSearchParams(query));
    const ssr = makeClientPageSsrSearchParamsThenable(new URLSearchParams(query), {
      isPprFallbackShell: true,
    });

    for (const searchParams of [browser, ssr]) {
      expect(searchParams.hasOwnProperty("q")).toBe(true);
      expect(searchParams.propertyIsEnumerable("q")).toBe(true);
      expect(searchParams.hasOwnProperty("missing")).toBe(false);
      // A reserved name isn't a query key.
      expect(searchParams.hasOwnProperty("then")).toBe(false);
    }
  });

  it("resolves to a plain object, like the SSR thenable", async () => {
    const record = await createClientPageSearchParams(new URLSearchParams("q=one&__proto__=x"));
    const ssrRecord = await makeClientPageSsrSearchParamsThenable(
      new URLSearchParams("q=one&__proto__=x"),
      { isPprFallbackShell: true },
    );

    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(record)).toBe(Object.getPrototypeOf(ssrRecord));
    expect(record.hasOwnProperty("q")).toBe(true);
    // A `__proto__` key stays an ordinary entry.
    expect(Object.keys(record)).toEqual(["q", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(record, "__proto__")?.value).toBe("x");
  });

  it("reads a query key named constructor like the SSR thenable, and stays awaitable", async () => {
    const query = "constructor=c&q=one";
    const browser = createClientPageSearchParams(new URLSearchParams(query));
    const ssr = makeClientPageSsrSearchParamsThenable(new URLSearchParams(query), {
      isPprFallbackShell: true,
    });

    for (const searchParams of [browser, ssr]) {
      expect(Reflect.get(searchParams, "constructor")).toBe("c");
      const record = await searchParams;
      expect(Reflect.get(record, "constructor")).toBe("c");
      expect(Reflect.get(record, "q")).toBe("one");
      await expect(searchParams.finally(() => {})).resolves.toBe(record);
    }
  });
});

type BrowserModules = {
  ClientPageRoot: typeof ClientPageRoot;
  navigation: typeof import("../packages/vinext/src/shims/navigation.js");
  slot: typeof import("../packages/vinext/src/shims/slot.js");
};

/** Load the shims as the browser does: with a `window`. */
async function withBrowserModules(run: (modules: BrowserModules) => Promise<void>): Promise<void> {
  const previousWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    location: {
      hash: "",
      href: "http://localhost/feed/bar",
      origin: "http://localhost",
      pathname: "/feed/bar",
      search: "",
    },
    history: { state: null, pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    vi.resetModules();
    const { ClientPageRoot: BrowserClientPageRoot } =
      await import("../packages/vinext/src/shims/client-page-root.js");
    const navigation = await import("../packages/vinext/src/shims/navigation.js");
    const slot = await import("../packages/vinext/src/shims/slot.js");
    await run({ ClientPageRoot: BrowserClientPageRoot, navigation, slot });
  } finally {
    vi.resetModules();
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Reflect.set(globalThis, "window", previousWindow);
    }
  }
}

function QueryPage({ searchParams }: SearchParamsProps): React.ReactNode {
  const record = React.use(searchParams);
  return React.createElement("p", null, `query:${JSON.stringify(record)}`);
}

function renderInBrowser(
  modules: BrowserModules,
  snapshot: ReturnType<BrowserModules["navigation"]["createClientNavigationRenderSnapshot"]>,
  pageProps: Record<string, unknown>,
  rootProps?: { emptySearchParams?: boolean },
): Promise<string> {
  const Context = modules.navigation.getClientNavigationRenderContext();
  if (!Context) throw new Error("Expected client navigation render context");
  return renderMarkup(
    React.createElement(
      Context.Provider,
      { value: snapshot },
      React.createElement(modules.ClientPageRoot, {
        Component: QueryPage as React.ComponentType<Record<string, unknown>>,
        pageProps,
        ...rootProps,
      }),
    ),
  );
}

describe("ClientPageRoot in the browser", () => {
  it("reads the query the server rendered, which a rewrite may change", async () => {
    // A rewrite from /feed/:tab to /feed?tab=:tab: the browser URL has no
    // query, and the navigation response names the rendered one.
    await withBrowserModules(async (modules) => {
      const snapshot = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/feed/bar",
        {},
        "/feed?tab=bar",
      );

      expect(snapshot.renderedSearch).toBe("?tab=bar");
      expect(await renderInBrowser(modules, snapshot, { params: {} })).toContain(
        "query:{&quot;tab&quot;:&quot;bar&quot;}",
      );
    });
  });

  it("reads the browser URL's query when the rendered one is unknown", async () => {
    await withBrowserModules(async (modules) => {
      const snapshot = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/feed?tab=hot",
        {},
      );

      expect(snapshot.renderedSearch).toBeUndefined();
      expect(await renderInBrowser(modules, snapshot, { params: {} })).toContain(
        "query:{&quot;tab&quot;:&quot;hot&quot;}",
      );
    });
  });

  it("keeps a mounted page's query when a later navigation changes the URL", async () => {
    // /feed?tab=hot, then an intercepted /photo/1 opens in @modal. The router
    // keeps the feed page's server output, so its props object is the same.
    await withBrowserModules(async (modules) => {
      const feedProps = { params: {} };
      const feed = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/feed?tab=hot",
        {},
        "/feed?tab=hot",
      );
      const photo = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/photo/1",
        { id: "1" },
        "/photo/1",
      );

      expect(await renderInBrowser(modules, feed, feedProps)).toContain("tab&quot;:&quot;hot");
      expect(await renderInBrowser(modules, photo, feedProps)).toContain("tab&quot;:&quot;hot");
      // A new server render of the page reads the navigation that sent it.
      expect(await renderInBrowser(modules, photo, { params: {} })).toContain("query:{}");
    });
  });

  it("reads the query a refreshed kept branch rendered with", async () => {
    // A refresh under an intercepted /photo/1 fetches the kept /feed?tab=hot
    // source page from its own URL and merges it into the navigation's tree.
    await withBrowserModules(async (modules) => {
      const Context = modules.navigation.getClientNavigationRenderContext();
      if (!Context) throw new Error("Expected client navigation render context");
      const photo = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/photo/1",
        { id: "1" },
        "/photo/1",
      );
      const renderSlot = (elements: Record<string, React.ReactNode>) =>
        renderMarkup(
          React.createElement(
            Context.Provider,
            { value: photo },
            React.createElement(
              modules.slot.ElementsContext.Provider,
              { value: elements },
              React.createElement(modules.slot.Slot, { id: "page:/feed" }),
            ),
          ),
        );
      const feedPage = () =>
        React.createElement(modules.ClientPageRoot, {
          Component: QueryPage as React.ComponentType<Record<string, unknown>>,
          pageProps: { params: {} },
        });

      const refreshed = { "page:/feed": feedPage() };
      modules.slot.setAppElementsRenderedSearch(refreshed, "?tab=hot");
      expect(await renderSlot(refreshed)).toContain("query:{&quot;tab&quot;:&quot;hot&quot;}");
      // The navigation's own output reads the navigation's query.
      expect(await renderSlot({ "page:/feed": feedPage() })).toContain("query:{}");
    });
  });

  it("reads its own navigation's query when a kept branch first renders under a later one", async () => {
    // /feed?tab=hot commits its loading shell while the page is still
    // streaming. An intercepted /photo/1 then keeps that branch, and the page
    // first renders under /photo/1.
    await withBrowserModules(async (modules) => {
      const { AppElementsWire, normalizeAppElements } =
        await import("../packages/vinext/src/server/app-elements.js");
      const { FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN, createPendingNavigationCommitFromElements } =
        await import("../packages/vinext/src/server/app-browser-state.js");
      const Context = modules.navigation.getClientNavigationRenderContext();
      if (!Context) throw new Error("Expected client navigation render context");
      const feed = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/feed?tab=hot",
        {},
        "/feed?tab=hot",
      );
      const photo = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/photo/1",
        { id: "1" },
        "/photo/1",
      );
      const createElements = (routeId: string, entries: Record<string, unknown>) =>
        normalizeAppElements({
          ...AppElementsWire.createMetadataEntries({
            interception: null,
            interceptionContext: null,
            layoutIds: [],
            rootLayoutTreePath: null,
            routeId,
            slotBindings: [],
            sourcePage: null,
          }),
          ...entries,
        });
      const feedPage = () =>
        React.createElement(modules.ClientPageRoot, {
          Component: QueryPage as React.ComponentType<Record<string, unknown>>,
          pageProps: { params: {} },
        });
      // A kept branch a refresh fetched from its own URL, merged in first.
      const refreshed = { "page:/refreshed": feedPage() };
      modules.slot.setAppElementsRenderedSearch(refreshed, "?tab=new");
      const feedElements = createElements("route:/feed", {
        "page:/feed": feedPage(),
        ...refreshed,
      });

      createPendingNavigationCommitFromElements({
        currentState: {
          activeOperation: null,
          bfcacheIds: {},
          elements: createElements("route:/", {}),
          interception: null,
          interceptionContext: null,
          layoutFlags: {},
          layoutIds: [],
          navigationSnapshot: modules.navigation.createClientNavigationRenderSnapshot(
            "http://localhost/",
            {},
          ),
          previousNextUrl: null,
          renderId: 0,
          rootLayoutTreePath: null,
          routeId: "route:/",
          slotBindings: [],
          visibleCommitVersion: 0,
        },
        navigationSnapshot: feed,
        nextElements: feedElements,
        operationLane: "navigation",
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        renderId: 1,
        type: "navigate",
      });

      const renderSlot = (id: string) =>
        renderMarkup(
          React.createElement(
            Context.Provider,
            { value: photo },
            React.createElement(
              modules.slot.ElementsContext.Provider,
              { value: feedElements },
              React.createElement(modules.slot.Slot, { id }),
            ),
          ),
        );
      expect(await renderSlot("page:/feed")).toContain("query:{&quot;tab&quot;:&quot;hot&quot;}");
      expect(await renderSlot("page:/refreshed")).toContain(
        "query:{&quot;tab&quot;:&quot;new&quot;}",
      );
    });
  });

  it("keeps handing a kept page the same promise", async () => {
    await withBrowserModules(async (modules) => {
      const received: unknown[] = [];
      function RecordingPage({ searchParams }: SearchParamsProps): React.ReactNode {
        received.push(searchParams);
        return null;
      }
      const Context = modules.navigation.getClientNavigationRenderContext();
      if (!Context) throw new Error("Expected client navigation render context");
      const pageProps = { params: {} };
      for (const href of ["http://localhost/feed?tab=hot", "http://localhost/feed?tab=new"]) {
        await renderMarkup(
          React.createElement(
            Context.Provider,
            { value: modules.navigation.createClientNavigationRenderSnapshot(href, {}) },
            React.createElement(modules.ClientPageRoot, {
              Component: RecordingPage as React.ComponentType<Record<string, unknown>>,
              pageProps,
            }),
          ),
        );
      }

      expect(received).toHaveLength(2);
      expect(received[0]).toBe(received[1]);
    });
  });

  it("hydrates a direct read of React's promise fields as SSR rendered it", async () => {
    // `status` and `value` are reserved on both sides, so these query keys
    // don't shadow them, and neither promise carries React's bookkeeping yet.
    function FieldsPage({ searchParams }: SearchParamsProps): React.ReactNode {
      const status = String(Reflect.get(searchParams, "status"));
      const value = String(Reflect.get(searchParams, "value"));
      return React.createElement("p", null, `status:${status} value:${value}`);
    }
    const query = "status=y&value=z";
    const ssrHtml = await inRequest(async () => {
      const searchParams = new URLSearchParams(query);
      setNavigationContext({
        pathname: "/client",
        searchParams,
        params: {},
        clientPageSearchParams: makeClientPageSsrSearchParamsThenable(searchParams, {}),
      });
      return renderPage(FieldsPage);
    });

    await withBrowserModules(async (modules) => {
      const Context = modules.navigation.getClientNavigationRenderContext();
      if (!Context) throw new Error("Expected client navigation render context");
      const browserHtml = await renderMarkup(
        React.createElement(
          Context.Provider,
          {
            value: modules.navigation.createClientNavigationRenderSnapshot(
              `http://localhost/client?${query}`,
              {},
            ),
          },
          React.createElement(modules.ClientPageRoot, {
            Component: FieldsPage as React.ComponentType<Record<string, unknown>>,
            pageProps: { params: {} },
          }),
        ),
      );

      expect(ssrHtml).toContain("status:undefined value:undefined");
      expect(browserHtml).toBe(ssrHtml);
    });
  });

  it("keeps a force-static page's query empty during a navigation", async () => {
    // SSR renders force-static pages with an empty query, and so does Next.js
    // in the browser, whatever the destination URL.
    await withBrowserModules(async (modules) => {
      const snapshot = modules.navigation.createClientNavigationRenderSnapshot(
        "http://localhost/static?value=hidden",
        {},
        "/static?value=hidden",
      );
      modules.navigation.activateNavigationSnapshot();

      expect(
        await renderInBrowser(modules, snapshot, { params: {} }, { emptySearchParams: true }),
      ).toContain("query:{}");
    });
  });
});
