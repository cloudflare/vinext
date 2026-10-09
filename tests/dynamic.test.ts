/**
 * next/dynamic shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-dynamic.test.tsx,
 * plus comprehensive coverage for vinext's dynamic() implementation:
 * SSR rendering, ssr:false behavior, loading components, error
 * boundaries, displayName assignment, and flushPreloads().
 */
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { renderToReadableStream } from "react-dom/server.edge";
import dynamic, {
  _pendingServerPreloadCount,
  flushPreloads,
} from "../packages/vinext/src/shims/dynamic.js";
import { withAppRouterTree } from "../packages/vinext/src/shims/app-router-tree-context.js";
import { createLoadableModuleCollector } from "../packages/vinext/src/shims/loadable-context.js";

// ─── Test components ────────────────────────────────────────────────────

function Hello() {
  return React.createElement("div", null, "Hello from dynamic");
}

function LoadingSpinner({ isLoading, error }: { isLoading?: boolean; error?: Error | null }) {
  if (error) return React.createElement("div", null, `Error: ${error.message}`);
  if (isLoading) return React.createElement("div", null, "Loading...");
  return null;
}

async function renderDynamicToHtml(component: React.ComponentType) {
  const stream = await renderToReadableStream(React.createElement(component));
  await stream.allReady;
  return new Response(stream).text();
}

// ─── SSR rendering ──────────────────────────────────────────────────────

describe("next/dynamic SSR", () => {
  it("renders dynamically imported component on server (mirrors Next.js test)", async () => {
    // Next.js test: dynamic(() => import('./fixtures/stub-components/hello'))
    // Verifies that next/dynamic doesn't crash
    const DynamicHello = dynamic(() => Promise.resolve({ default: Hello }));

    // On server, this uses React.lazy
    // renderToString will resolve the lazy component synchronously for simple promises
    expect(DynamicHello.displayName).toBe("DynamicServer");
  });

  it("sets correct displayName for server component", () => {
    const DynamicComponent = dynamic(() => Promise.resolve({ default: Hello }));
    expect(DynamicComponent.displayName).toBe("DynamicServer");
  });

  it("handles modules exporting bare component (no default)", async () => {
    // Some dynamic imports export the component directly
    const DynamicComponent = dynamic(() => Promise.resolve(Hello as any));
    expect(DynamicComponent.displayName).toBe("DynamicServer");
  });

  it("accepts a direct loader promise", async () => {
    // Ported from Next.js: test/development/basic/next-dynamic/pages/dynamic/ssr.js
    // https://github.com/vercel/next.js/blob/canary/test/development/basic/next-dynamic/pages/dynamic/ssr.js
    const DynamicComponent = dynamic(Promise.resolve({ default: Hello }));

    await flushPreloads();
    await expect(renderDynamicToHtml(DynamicComponent)).resolves.toContain("Hello from dynamic");
  });

  it("accepts an options object with loader", async () => {
    // Ported from Next.js: test/development/basic/next-dynamic/pages/dynamic/head.js
    // https://github.com/vercel/next.js/blob/canary/test/development/basic/next-dynamic/pages/dynamic/head.js
    const DynamicComponent = dynamic({
      loader: () => Promise.resolve({ default: Hello }),
    });

    await flushPreloads();
    await expect(renderDynamicToHtml(DynamicComponent)).resolves.toContain("Hello from dynamic");
  });
});

// ─── Suspense boundary ──────────────────────────────────────────────────

describe("next/dynamic Suspense boundary without loading (issue #3718)", () => {
  function createSlowDynamic() {
    return dynamic(
      () =>
        new Promise<{ default: typeof Hello }>((resolve) => {
          setTimeout(() => resolve({ default: Hello }), 20);
        }),
    );
  }

  it("renders inline with no boundary in an App Router tree", async () => {
    // Ported from Next.js App Router Loadable: a boundary only for ssr:false or loading.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/lazy-dynamic/loadable.tsx
    const SlowDynamic = createSlowDynamic();
    const AppTree = () => withAppRouterTree(React.createElement(SlowDynamic));
    const html = await renderDynamicToHtml(AppTree);
    expect(html).toBe("<div>Hello from dynamic</div>");
  });
});

// ─── Pages Router loadable ──────────────────────────────────────────────
// Ported from Next.js's react-loadable fork, which Pages Router dynamic() uses:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/loadable.shared-runtime.tsx

describe("next/dynamic outside an App Router tree (Pages Router loadable)", () => {
  function slowModule<T>(value: T, ms = 20): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  it("renders a preloaded component inline with no Suspense boundary", async () => {
    const SlowDynamic = dynamic(() => slowModule({ default: Hello }));
    await flushPreloads();
    const html = await renderDynamicToHtml(SlowDynamic);
    expect(html).toBe("<div>Hello from dynamic</div>");
  });

  it("renders the loading component, before its delay, when not preloaded", async () => {
    let receivedProps: Record<string, unknown> | null = null;
    const Loading = (props: Record<string, unknown>) => {
      receivedProps = props;
      return React.createElement("p", null, "loading");
    };
    let release!: () => void;
    const SlowDynamic = dynamic(
      () =>
        new Promise<{ default: typeof Hello }>((resolve) => {
          release = () => resolve({ default: Hello });
        }),
      { loading: Loading },
    );
    // No flushPreloads(): the server renders the loading state, never suspending.
    const html = await renderDynamicToHtml(SlowDynamic);
    expect(html).toBe("<p>loading</p>");
    expect(receivedProps).toEqual({
      isLoading: true,
      pastDelay: false,
      timedOut: false,
      error: null,
      retry: expect.any(Function),
    });
    release();
    await flushPreloads();
  });

  it("renders nothing while loading without a loading option", async () => {
    let release!: () => void;
    const SlowDynamic = dynamic(
      () =>
        new Promise<{ default: typeof Hello }>((resolve) => {
          release = () => resolve({ default: Hello });
        }),
    );
    const html = await renderDynamicToHtml(SlowDynamic);
    expect(html).toBe("");
    release();
    await flushPreloads();
  });

  it("preloads dynamic() calls made by modules it loads", async () => {
    let Inner: React.ComponentType | null = null;
    const Outer = dynamic(async () => {
      // A loaded module that calls dynamic() itself.
      Inner = dynamic(() => slowModule({ default: Hello }));
      const InnerComponent = Inner;
      return { default: () => React.createElement(InnerComponent) };
    });
    await flushPreloads();
    expect(Inner).not.toBeNull();
    expect(await renderDynamicToHtml(Outer)).toBe("<div>Hello from dynamic</div>");
  });

  it("reports the rendered modules through LoadableContext", async () => {
    const Rendered = dynamic(() => slowModule({ default: Hello }), {
      loadableGenerated: { modules: ["components/rendered.tsx"] },
    } as never);
    dynamic(() => slowModule({ default: Hello }), {
      loadableGenerated: { modules: ["components/not-rendered.tsx"] },
    } as never);
    // Like Next.js's noSSR(), an ssr: false dynamic() is never listed.
    const NoSSR = dynamic(() => slowModule({ default: Hello }), {
      ssr: false,
      loadableGenerated: { modules: ["components/no-ssr.tsx"] },
    } as never);
    await flushPreloads();

    const loadableModules = createLoadableModuleCollector();
    const Page = () =>
      loadableModules.wrap(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Rendered),
          React.createElement(NoSSR),
          React.createElement(Rendered),
        ),
      );
    await renderDynamicToHtml(Page);
    expect(loadableModules.getDynamicIds()).toEqual(["components/rendered.tsx"]);
    expect(createLoadableModuleCollector().getDynamicIds()).toBeUndefined();
  });

  // Divergence from Next.js, whose preloadAll() rejects (failing the first
  // request): vinext imports every page up front, so it logs instead and
  // renders the error the way Next.js does on later requests.
  it("logs a failed load instead of rejecting, then renders the loading component with the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const Failing = dynamic(() => Promise.reject(new Error("chunk failed")), {
        loading: LoadingSpinner,
      });
      await expect(flushPreloads()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("next/dynamic failed to load"),
        expect.objectContaining({ message: "chunk failed" }),
      );
      expect(await renderDynamicToHtml(Failing)).toBe("<div>Error: chunk failed</div>");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("makes a request that starts mid-preload wait for the same loads", async () => {
    const SlowDynamic = dynamic(() => slowModule({ default: Hello }, 30));
    const first = flushPreloads();
    // A concurrent request finds nothing left to start, but the load is still
    // in flight: it must not render the loading state.
    await flushPreloads();
    expect(await renderDynamicToHtml(SlowDynamic)).toBe("<div>Hello from dynamic</div>");
    await first;
  });

  // Next.js's LoadableComponent keeps the ref for its `{ retry }` handle.
  it("does not pass a ref through to the loaded component", async () => {
    let received: Record<string, unknown> | null = null;
    const Loaded = (props: Record<string, unknown>) => {
      received = props;
      return React.createElement("div", null, "loaded");
    };
    const Dyn = dynamic(() => slowModule({ default: Loaded })) as React.ComponentType<{
      label: string;
      ref?: React.Ref<unknown>;
    }>;
    await flushPreloads();
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(Dyn, { label: "x", ref: React.createRef() }),
    );
    expect(received).toEqual({ label: "x" });
  });

  it("does not keep dynamic() calls an App Router render makes on the server preload list", async () => {
    await flushPreloads();
    // dynamic() called during render (Next.js documents module scope only).
    function AppPage() {
      const Inline = dynamic(() => slowModule({ default: Hello }));
      return React.createElement(Inline);
    }
    for (let i = 0; i < 3; i++) {
      await renderDynamicToHtml(() => withAppRouterTree(React.createElement(AppPage)));
    }
    expect(_pendingServerPreloadCount()).toBe(0);
  });

  it("still renders a dynamic() shared with an App Router tree loaded in a Pages tree", async () => {
    await flushPreloads();
    let calls = 0;
    const Shared = dynamic(() => {
      calls++;
      return slowModule({ default: Hello }, 50);
    });
    const appRender = renderDynamicToHtml(() => withAppRouterTree(React.createElement(Shared)));
    await vi.waitFor(() => expect(calls).toBe(1));
    // A Pages request arriving while the App render's load is in flight
    // waits for it in its preload.
    await flushPreloads();
    expect(await renderDynamicToHtml(Shared)).toBe("<div>Hello from dynamic</div>");
    await appRender;
  });

  it("shares one load between an App Router render and the Pages preload", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await flushPreloads();
      let calls = 0;
      const Shared = dynamic(() => {
        calls++;
        return slowModule({ default: Hello });
      });
      await renderDynamicToHtml(() => withAppRouterTree(React.createElement(Shared)));
      await flushPreloads();
      expect(await renderDynamicToHtml(Shared)).toBe("<div>Hello from dynamic</div>");
      expect(calls).toBe(1);

      // An App Router render's failure goes to React, not the preload log.
      const Failing = dynamic(() => Promise.reject(new Error("chunk failed")), {
        loading: LoadingSpinner,
      });
      await renderDynamicToHtml(() => withAppRouterTree(React.createElement(Failing)));
      await flushPreloads();
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("next/dynamic failed to load"),
        expect.anything(),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  describe("loading timers and retry", () => {
    // Loads held open until the test ends, then settled so later
    // flushPreloads() calls don't wait on them.
    const releases: (() => void)[] = [];

    afterEach(async () => {
      vi.useRealTimers();
      for (const release of releases.splice(0)) release();
      await flushPreloads();
    });

    function pendingLoader() {
      return () =>
        new Promise<{ default: typeof Hello }>((resolve) => {
          releases.push(() => resolve({ default: Hello }));
        });
    }

    function recordingLoading(calls: Record<string, unknown>[]) {
      return (props: Record<string, unknown>) => {
        calls.push(props);
        return null;
      };
    }

    it("passes pastDelay once the default 200ms delay has elapsed", () => {
      vi.useFakeTimers();
      const calls: Record<string, unknown>[] = [];
      const SlowDynamic = dynamic(pendingLoader(), { loading: recordingLoading(calls) });

      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));
      vi.advanceTimersByTime(199);
      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));
      vi.advanceTimersByTime(1);
      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));

      expect(calls.map((props) => props.pastDelay)).toEqual([false, false, true]);
    });

    it("passes pastDelay right away with delay: 0", () => {
      const calls: Record<string, unknown>[] = [];
      const SlowDynamic = dynamic(pendingLoader(), {
        loading: recordingLoading(calls),
        delay: 0,
      } as never);
      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));
      expect(calls[0]).toMatchObject({ isLoading: true, pastDelay: true, timedOut: false });
    });

    it("passes timedOut once the timeout has elapsed", () => {
      vi.useFakeTimers();
      const calls: Record<string, unknown>[] = [];
      const SlowDynamic = dynamic(pendingLoader(), {
        loading: recordingLoading(calls),
        timeout: 500,
      } as never);

      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));
      vi.advanceTimersByTime(500);
      ReactDOMServer.renderToStaticMarkup(React.createElement(SlowDynamic));

      expect(calls.map((props) => props.timedOut)).toEqual([false, true]);
    });

    it("retry() calls the loader again after a failure", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let attempts = 0;
        let retry!: () => void;
        const Flaky = dynamic(
          () => {
            attempts++;
            return attempts === 1
              ? Promise.reject(new Error("chunk failed"))
              : Promise.resolve({ default: Hello });
          },
          {
            loading: (props: { error?: Error | null; retry?: () => void }) => {
              retry = props.retry!;
              return props.error ? React.createElement("p", null, props.error.message) : null;
            },
          },
        );
        await flushPreloads();
        expect(ReactDOMServer.renderToStaticMarkup(React.createElement(Flaky))).toBe(
          "<p>chunk failed</p>",
        );

        retry();
        expect(attempts).toBe(2);
        await vi.waitFor(() =>
          expect(ReactDOMServer.renderToStaticMarkup(React.createElement(Flaky))).toBe(
            "<div>Hello from dynamic</div>",
          ),
        );
      } finally {
        consoleError.mockRestore();
      }
    });

    it("renders nothing for an error in the default loading component in production", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("NODE_ENV", "production");
      try {
        const Failing = dynamic(() => Promise.reject(new Error("chunk failed")), {
          delay: 0,
        } as never);
        await flushPreloads();
        expect(ReactDOMServer.renderToStaticMarkup(React.createElement(Failing))).toBe("");
      } finally {
        vi.unstubAllEnvs();
        consoleError.mockRestore();
      }
    });

    // Next.js's default loading component shows the error outside production.
    it("renders the error in the default loading component", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const error = new Error("chunk failed");
        error.stack = "Error: chunk failed\n    at loader";
        const Failing = dynamic(() => Promise.reject(error), { delay: 0 } as never);
        await flushPreloads();
        expect(ReactDOMServer.renderToStaticMarkup(React.createElement(Failing))).toBe(
          "<p>chunk failed<br/>Error: chunk failed\n    at loader</p>",
        );
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  it("reports environment-independent loadable keys rather than resolved module ids", async () => {
    const Widget = dynamic(() => slowModule({ default: Hello }), {
      loadableGenerated: {
        modules: ["node_modules/widget/dist/node.js"],
        loadableKeys: ["pages/index.tsx -> widget"],
      },
    } as never);
    await flushPreloads();

    const loadableModules = createLoadableModuleCollector();
    await renderDynamicToHtml(() => loadableModules.wrap(React.createElement(Widget)));
    expect(loadableModules.getDynamicIds()).toEqual(["pages/index.tsx -> widget"]);
  });
});

describe("next/dynamic in a pure App Router build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Next.js's App Router layer always uses React.lazy, even for a render
  // outside the App Router root (e.g. user code calling renderToString).
  it("waits for the component in a server render outside the App Router tree", async () => {
    vi.stubEnv("__VINEXT_HAS_PAGES_ROUTER", "false");
    vi.resetModules();
    const { default: appOnlyDynamic } = await import("../packages/vinext/src/shims/dynamic.js");
    const Widget = appOnlyDynamic(
      () =>
        new Promise<{ default: typeof Hello }>((resolve) =>
          setTimeout(() => resolve({ default: Hello }), 10),
        ),
    );
    expect(await renderDynamicToHtml(Widget)).toBe("<div>Hello from dynamic</div>");
  });
});

// ─── Pages Router loadable in the browser ───────────────────────────────

describe("next/dynamic in the browser (Pages Router loadable)", () => {
  const registryKey = Symbol.for("vinext.loadableRegistry");
  const globals = globalThis as Record<symbol, unknown>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    delete globals[registryKey];
  });

  async function importBrowserShim(
    windowValue: { next?: { appDir?: boolean }; __NEXT_HYDRATED?: boolean } & Pick<
      Window,
      "__NEXT_PRELOADREADY"
    > = {
      __NEXT_PRELOADREADY: undefined,
    },
  ) {
    vi.resetModules();
    // The browser registry lives on a global symbol, so a fresh module needs it reset.
    delete globals[registryKey];
    vi.stubGlobal("window", windowValue);
    const mod = await import("../packages/vinext/src/shims/dynamic.js");
    return {
      dynamic: mod.default,
      preloadReady: windowValue.__NEXT_PRELOADREADY!,
    };
  }

  function countingLoader(calls: string[], name: string) {
    return () => {
      calls.push(name);
      return Promise.resolve({ default: Hello });
    };
  }

  it("preloads only the dynamic() calls the server rendered, then stops registering", async () => {
    const { dynamic: browserDynamic, preloadReady } = await importBrowserShim();
    const calls: string[] = [];
    browserDynamic(countingLoader(calls, "rendered"), {
      loadableGenerated: { modules: ["a.tsx"], loadableKeys: ["pages/a.tsx -> ./a"] },
    } as never);
    browserDynamic(countingLoader(calls, "not-rendered"), {
      loadableGenerated: { modules: ["b.tsx"], loadableKeys: ["pages/a.tsx -> ./b"] },
    } as never);

    await preloadReady(["pages/a.tsx -> ./a"]);
    expect(calls).toEqual(["rendered"]);

    // After hydration, new dynamic() calls (client navigations) load on render.
    browserDynamic(countingLoader(calls, "after-hydration"), {
      loadableGenerated: { modules: ["c.tsx"], loadableKeys: ["pages/c.tsx -> ./c"] },
    } as never);
    await preloadReady(["pages/c.tsx -> ./c"]);
    expect(calls).toEqual(["rendered"]);
  });

  it("preloads dynamic() calls made by the modules it loads before resolving", async () => {
    const { dynamic: browserDynamic, preloadReady } = await importBrowserShim();
    const calls: string[] = [];
    browserDynamic(
      async () => {
        calls.push("outer");
        // The loaded module calls dynamic() at its top level once its import
        // resolves, after the current batch of preloads has started.
        await Promise.resolve();
        browserDynamic(countingLoader(calls, "inner"), {
          loadableGenerated: { modules: ["inner.tsx"], loadableKeys: ["outer.tsx -> ./inner"] },
        } as never);
        return { default: Hello };
      },
      {
        loadableGenerated: { modules: ["outer.tsx"], loadableKeys: ["pages/a.tsx -> ./outer"] },
      } as never,
    );

    await preloadReady(["pages/a.tsx -> ./outer", "outer.tsx -> ./inner"]);
    expect(calls).toEqual(["outer", "inner"]);
  });

  it("does not register when first loaded after hydration", async () => {
    const { dynamic: browserDynamic, preloadReady } = await importBrowserShim({
      __NEXT_HYDRATED: true,
      __NEXT_PRELOADREADY: undefined,
    });
    const calls: string[] = [];
    browserDynamic(countingLoader(calls, "late"), {
      loadableGenerated: { modules: ["a.tsx"], loadableKeys: ["pages/a.tsx -> ./a"] },
    } as never);
    await preloadReady(["pages/a.tsx -> ./a"]);
    expect(calls).toEqual([]);
  });

  it("resolves even when a preloaded loader fails", async () => {
    const { dynamic: browserDynamic, preloadReady } = await importBrowserShim();
    browserDynamic(() => Promise.reject(new Error("chunk failed")), {
      loadableGenerated: { modules: ["a.tsx"], loadableKeys: ["pages/a.tsx -> ./a"] },
    } as never);
    await expect(preloadReady(["pages/a.tsx -> ./a"])).resolves.toBeUndefined();
  });

  it("does not register in an App Router document", async () => {
    const { dynamic: browserDynamic, preloadReady } = await importBrowserShim({
      next: { appDir: true },
      __NEXT_PRELOADREADY: undefined,
    });
    const calls: string[] = [];
    browserDynamic(countingLoader(calls, "app"), {
      loadableGenerated: { modules: ["a.tsx"], loadableKeys: ["app/page.tsx -> ./a"] },
    } as never);
    await preloadReady(["app/page.tsx -> ./a"]);
    expect(calls).toEqual([]);
  });

  // The client's first render must match the server's noSSR() output.
  it("renders an ssr: false loading component before its delay, like the server", async () => {
    const { dynamic: browserDynamic } = await importBrowserShim();
    let receivedProps: Record<string, unknown> | null = null;
    const Loading = (props: Record<string, unknown>) => {
      receivedProps = props;
      return props.pastDelay ? React.createElement("div", null, "Delayed loading") : null;
    };
    const DynamicNoSSR = browserDynamic(() => Promise.resolve({ default: Hello }), {
      ssr: false,
      loading: Loading,
    });

    expect(ReactDOMServer.renderToStaticMarkup(React.createElement(DynamicNoSSR))).toBe("");
    expect(receivedProps).toEqual({
      error: null,
      isLoading: true,
      pastDelay: false,
      timedOut: false,
      retry: expect.any(Function),
    });
  });

  it("does not install the preload hook in a pure App Router build", async () => {
    vi.stubEnv("__VINEXT_HAS_PAGES_ROUTER", "false");
    const { preloadReady } = await importBrowserShim();
    expect(preloadReady).toBeUndefined();
  });
});

// ─── SSR: false ─────────────────────────────────────────────────────────

describe("next/dynamic ssr: false", () => {
  it("renders loading component on server when ssr: false", () => {
    const DynamicNoSSR = dynamic(() => Promise.resolve({ default: Hello }), {
      ssr: false,
      loading: LoadingSpinner,
    });

    const html = ReactDOMServer.renderToString(React.createElement(DynamicNoSSR));
    expect(html).toContain("Loading...");
    expect(html).not.toContain("Hello from dynamic");
  });

  it("renders the loading UI on the server with pastDelay:true so it matches the client first render (issue 1967)", () => {
    // App Router always renders the loading fallback with pastDelay=true on BOTH
    // server and client. A loading component that branches on pastDelay (the
    // documented `if (!pastDelay) return null` pattern) must therefore render the
    // same thing on the server as it does on the client's first/pre-mount render —
    // otherwise hydration mismatches (issue 1967).
    const LoadingAfterDelay = ({ pastDelay }: { pastDelay?: boolean }) =>
      pastDelay ? React.createElement("div", null, "Delayed loading") : null;
    const DynamicNoSSR = dynamic(() => Promise.resolve({ default: Hello }), {
      ssr: false,
      loading: LoadingAfterDelay,
    });

    const serverHtml = ReactDOMServer.renderToStaticMarkup(
      withAppRouterTree(React.createElement(DynamicNoSSR)),
    );
    // Canonical client first-render output: the loading component rendered with
    // pastDelay:true, which is exactly what ClientSSRFalse emits pre-mount via
    // createDynamicLoadingProps().
    const clientFirstRenderHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LoadingAfterDelay, { pastDelay: true }),
    );

    expect(serverHtml).toContain("Delayed loading");
    expect(serverHtml).toBe(clientFirstRenderHtml);
  });

  // Ported from Next.js's Pages Router noSSR():
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/dynamic.tsx
  it("renders the loading component before its delay outside an App Router tree", () => {
    let receivedProps: unknown = null;
    const Loading = (props: Record<string, unknown>) => {
      receivedProps = props;
      return props.pastDelay ? React.createElement("div", null, "Delayed loading") : null;
    };
    const DynamicNoSSR = dynamic(() => Promise.resolve({ default: Hello }), {
      ssr: false,
      loading: Loading,
    });

    expect(ReactDOMServer.renderToStaticMarkup(React.createElement(DynamicNoSSR))).toBe("");
    expect(receivedProps).toEqual({
      error: null,
      isLoading: true,
      pastDelay: false,
      timedOut: false,
    });
  });

  it("renders nothing on server when ssr: false and no loading", () => {
    const DynamicNoSSR = dynamic(() => Promise.resolve({ default: Hello }), { ssr: false });

    const html = ReactDOMServer.renderToString(React.createElement(DynamicNoSSR));
    expect(html).toBe("");
  });

  it("sets DynamicSSRFalse displayName on server", () => {
    const DynamicNoSSR = dynamic(() => Promise.resolve({ default: Hello }), { ssr: false });
    expect(DynamicNoSSR.displayName).toBe("DynamicSSRFalse");
  });
});

// ─── Loading component ──────────────────────────────────────────────────

describe("next/dynamic loading component", () => {
  it("passes the App Router loading props (pastDelay:true) to loading component on SSR", () => {
    let receivedProps: any = null;
    function TrackingLoader(props: any) {
      receivedProps = props;
      return React.createElement("div", null, "tracking");
    }

    const DynamicWithTracking = dynamic(() => Promise.resolve({ default: Hello }), {
      ssr: false,
      loading: TrackingLoader,
    });

    ReactDOMServer.renderToString(withAppRouterTree(React.createElement(DynamicWithTracking)));

    // pastDelay is true on the server to match the client's first render and the
    // Next.js App Router contract (issue 1967).
    expect(receivedProps).toEqual({
      isLoading: true,
      pastDelay: true,
      error: null,
      timedOut: false,
      retry: expect.any(Function),
    });
  });
});

// ─── Default options ────────────────────────────────────────────────────

describe("next/dynamic defaults", () => {
  it("defaults ssr to true", () => {
    const DynamicDefault = dynamic(() => Promise.resolve({ default: Hello }));
    // If ssr defaults to true, we get DynamicServer, not DynamicSSRFalse
    expect(DynamicDefault.displayName).toBe("DynamicServer");
  });

  it("handles undefined options", () => {
    const DynamicNoOpts = dynamic(() => Promise.resolve({ default: Hello }), undefined);
    expect(DynamicNoOpts.displayName).toBe("DynamicServer");
  });
});

// ─── flushPreloads ──────────────────────────────────────────────────────

describe("flushPreloads", () => {
  it("resolves when there is nothing to preload", async () => {
    await flushPreloads();
    await expect(flushPreloads()).resolves.toBeUndefined();
  });

  it("loads each dynamic() once", async () => {
    let calls = 0;
    dynamic(() => {
      calls++;
      return Promise.resolve({ default: Hello });
    });
    await flushPreloads();
    await flushPreloads();
    expect(calls).toBe(1);
  });
});

// ─── RSC async component path ────────────────────────────────────────────
//
// React 19.x exports React.lazy from the react-server condition, so the
// `typeof React.lazy !== "function"` guard does NOT trigger in current
// React. The AsyncServerDynamic path is defensive forward-compatibility
// code for hypothetical future React versions that strip lazy from RSC.
//
// We verify it here by temporarily stubbing React.lazy to undefined,
// simulating the react-server environment of older or stripped React builds.

describe("next/dynamic RSC async component path (React.lazy unavailable)", () => {
  it("returns an async component (DynamicAsyncServer) when React.lazy is not a function", () => {
    const originalLazy = React.lazy;
    try {
      // @ts-expect-error — simulating react-server condition where lazy is absent
      React.lazy = undefined;

      const DynamicRsc = dynamic(() => Promise.resolve({ default: Hello }));
      expect(DynamicRsc.displayName).toBe("DynamicAsyncServer");
    } finally {
      React.lazy = originalLazy;
    }
  });

  it("async component resolves and renders the dynamically loaded component", async () => {
    const originalLazy = React.lazy;
    try {
      // @ts-expect-error — simulating react-server condition where lazy is absent
      React.lazy = undefined;

      const DynamicRsc = dynamic(() => Promise.resolve({ default: Hello }));
      // The returned component is an async function — call it directly as RSC would
      const element = await (DynamicRsc as unknown as (props: object) => Promise<unknown>)({});
      // Should return a React element rendered from Hello
      expect(element).toBeTruthy();
      expect((element as React.ReactElement).type).toBe(Hello);
    } finally {
      React.lazy = originalLazy;
    }
  });

  it("async component handles modules exporting bare component (no default)", async () => {
    const originalLazy = React.lazy;
    try {
      // @ts-expect-error — simulating react-server condition where lazy is absent
      React.lazy = undefined;

      const DynamicRsc = dynamic(() => Promise.resolve(Hello as any));
      const element = await (DynamicRsc as unknown as (props: object) => Promise<unknown>)({});
      expect((element as React.ReactElement).type).toBe(Hello);
    } finally {
      React.lazy = originalLazy;
    }
  });

  it("async component ignores LoadingComponent (defers to parent Suspense boundary)", () => {
    const originalLazy = React.lazy;
    try {
      // @ts-expect-error — simulating react-server condition where lazy is absent
      React.lazy = undefined;

      // LoadingComponent is passed but should be silently ignored in RSC path
      const DynamicRsc = dynamic(() => Promise.resolve({ default: Hello }), {
        loading: LoadingSpinner,
      });
      expect(DynamicRsc.displayName).toBe("DynamicAsyncServer");
    } finally {
      React.lazy = originalLazy;
    }
  });
});
