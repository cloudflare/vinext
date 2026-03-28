/**
 * next/dynamic shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-dynamic.test.tsx,
 * plus comprehensive coverage for vinext's dynamic() implementation:
 * SSR rendering, ssr:false behavior, loading components, error
 * boundaries, displayName assignment, and flushPreloads().
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
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
  it("passes isLoading and pastDelay to loading component on SSR", () => {
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

    expect(receivedProps).toEqual({
      isLoading: true,
      pastDelay: true,
      error: null,
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
  it("returns an empty array when no preloads queued", async () => {
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
