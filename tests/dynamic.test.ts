/**
 * next/dynamic shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-dynamic.test.tsx,
 * plus comprehensive coverage for vinext's dynamic() implementation:
 * SSR rendering, ssr:false behavior, loading components, error
 * boundaries, displayName assignment, and flushPreloads().
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { renderToReadableStream } from "react-dom/server.edge";
import dynamic, { flushPreloads } from "../packages/vinext/src/shims/dynamic.js";

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

    // On server, this uses React.lazy + Suspense
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

    await expect(renderDynamicToHtml(DynamicComponent)).resolves.toContain("Hello from dynamic");
  });

  it("accepts an options object with loader", async () => {
    // Ported from Next.js: test/development/basic/next-dynamic/pages/dynamic/head.js
    // https://github.com/vercel/next.js/blob/canary/test/development/basic/next-dynamic/pages/dynamic/head.js
    const DynamicComponent = dynamic({
      loader: () => Promise.resolve({ default: Hello }),
    });

    await expect(renderDynamicToHtml(DynamicComponent)).resolves.toContain("Hello from dynamic");
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

    const serverHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(DynamicNoSSR));
    // Canonical client first-render output: the loading component rendered with
    // pastDelay:true, which is exactly what ClientSSRFalse emits pre-mount via
    // createDynamicLoadingProps().
    const clientFirstRenderHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LoadingAfterDelay, { pastDelay: true }),
    );

    expect(serverHtml).toContain("Delayed loading");
    expect(serverHtml).toBe(clientFirstRenderHtml);
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

    ReactDOMServer.renderToString(React.createElement(DynamicWithTracking));

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
  it("returns an empty array when there is no separate preload work", async () => {
    const result = await flushPreloads();
    expect(result).toEqual([]);
  });

  it("can be called multiple times safely", async () => {
    await flushPreloads();
    const result = await flushPreloads();
    expect(result).toEqual([]);
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

// ─── Browser: lazy chunk failures ───────────────────────────────────────

describe("next/dynamic in the browser when a chunk cannot load", () => {
  type ChunkRecovery = typeof import("../packages/vinext/src/client/chunk-load-recovery.js");
  let recovery: ChunkRecovery;
  let browserDynamic: typeof dynamic;
  let navigator: ReturnType<
    typeof vi.fn<Parameters<ChunkRecovery["setChunkRecoveryNavigator"]>[0]>
  >;
  let fetchEntry: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const storage = new Map<string, string>();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    // isServer is decided when the module loads, so window must exist first.
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    });
    vi.resetModules();
    recovery = await import("../packages/vinext/src/client/chunk-load-recovery.js");
    browserDynamic = (await import("../packages/vinext/src/shims/dynamic.js")).default;

    navigator = vi.fn((outcome) => {
      queueMicrotask(() => outcome.onCanceled());
      return true;
    });
    fetchEntry = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchEntry);
    recovery.registerChunkRecovery({ entryUrl: "/assets/index-new.js" });
    recovery.setChunkRecoveryNavigator(navigator);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function renderBrowserDynamic(loader: () => Promise<{ default: React.ComponentType }>) {
    const errors: unknown[] = [];
    const Dynamic = browserDynamic(loader);
    const stream = await renderToReadableStream(React.createElement(Dynamic), {
      onError: (error) => void errors.push(error),
    });
    const ready = stream.allReady.catch(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    await ready;
    return { errors, html: await new Response(stream).text() };
  }

  it("renders the component without probing the build or recovering", async () => {
    const { errors, html } = await renderBrowserDynamic(async () => ({ default: Hello }));

    expect(html).toContain("Hello from dynamic");
    expect(errors).toEqual([]);
    expect(fetchEntry).not.toHaveBeenCalled();
    expect(navigator).not.toHaveBeenCalled();
  });

  it("loads the document once when the build was replaced, without rerunning the loader", async () => {
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const loader = vi.fn(async (): Promise<{ default: React.ComponentType }> => {
      throw failure;
    });

    const { errors } = await renderBrowserDynamic(loader);

    expect(loader).toHaveBeenCalledOnce();
    expect(fetchEntry).toHaveBeenCalledOnce();
    expect(navigator).toHaveBeenCalledOnce();
    // The navigator reported a canceled load, so the original error reaches the boundary.
    expect(errors).toEqual([failure]);
  });

  it("surfaces the error, without reloading or rerunning the loader, when the build is still live", async () => {
    fetchEntry.mockResolvedValue(
      new Response(null, { headers: { "content-type": "text/javascript" }, status: 200 }),
    );
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const loader = vi.fn(async (): Promise<{ default: React.ComponentType }> => {
      throw failure;
    });

    const { errors } = await renderBrowserDynamic(loader);

    expect(loader).toHaveBeenCalledOnce();
    expect(navigator).not.toHaveBeenCalled();
    expect(errors).toEqual([failure]);
  });
});
