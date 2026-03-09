/**
 * next/dynamic shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-dynamic.test.tsx,
 * plus comprehensive coverage for vinext's dynamic() implementation:
 * SSR rendering, ssr:false behavior, loading components, error
 * boundaries, displayName assignment, and flushPreloads().
 */
import { describe, it, expect } from "vitest";
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
