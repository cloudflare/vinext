import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useErrorBoundaryPathname } from "../packages/vinext/src/shims/error-boundary-navigation.js";
import { setNavigationContext } from "../packages/vinext/src/shims/navigation-server.js";
import { ssrAppRouterInstance } from "../packages/vinext/src/server/app-ssr-router-instance.js";
import {
  createClientNavigationRenderSnapshot,
  getClientNavigationRenderContext,
} from "../packages/vinext/src/shims/navigation.js";
import {
  createPprFallbackShellState,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

const CLIENT_NAVIGATION_STATE_KEY = Symbol.for("vinext.clientNavigationState");

afterEach(() => {
  setNavigationContext(null);
  Reflect.deleteProperty(globalThis, CLIENT_NAVIGATION_STATE_KEY);
  vi.restoreAllMocks();
});

describe("lightweight App Router SSR runtime", () => {
  it("reads the request pathname without loading the browser navigation runtime", () => {
    setNavigationContext({
      pathname: "/dashboard",
      searchParams: new URLSearchParams(),
      params: {},
    });

    function PathnameProbe() {
      return createElement("span", null, useErrorBoundaryPathname());
    }

    expect(renderToString(createElement(PathnameProbe))).toContain("/dashboard");
  });

  it("marks pathname reads as dynamic in fallback shells with unresolved params", () => {
    setNavigationContext({
      pathname: "/blog/[slug]",
      searchParams: new URLSearchParams(),
      params: { slug: "[slug]" },
    });
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/blog/:slug",
    });

    function PathnameProbe() {
      return createElement("span", null, useErrorBoundaryPathname());
    }

    runWithPprFallbackShellState(state, () => {
      renderToString(createElement(PathnameProbe));
    });

    expect(state.hasDynamicBoundary).toBe(true);
  });

  it("reads the pending pathname while a navigation render snapshot is active", () => {
    setNavigationContext({
      pathname: "/errored",
      searchParams: new URLSearchParams(),
      params: {},
    });
    Reflect.set(globalThis, CLIENT_NAVIGATION_STATE_KEY, {
      cachedPathname: "/errored",
      listeners: new Set(),
      navigationSnapshotActiveCount: 1,
    });

    const NavigationRenderContext = getClientNavigationRenderContext();
    if (!NavigationRenderContext) {
      throw new Error("Expected client navigation render context");
    }
    const snapshot = createClientNavigationRenderSnapshot("/destination", {});

    function PathnameProbe() {
      return createElement("span", null, useErrorBoundaryPathname());
    }

    expect(
      renderToString(
        createElement(
          NavigationRenderContext.Provider,
          { value: snapshot },
          createElement(PathnameProbe),
        ),
      ),
    ).toContain("/destination");
  });

  it("ignores a stale navigation render snapshot after commit", () => {
    setNavigationContext({
      pathname: "/committed",
      searchParams: new URLSearchParams(),
      params: {},
    });
    Reflect.set(globalThis, CLIENT_NAVIGATION_STATE_KEY, {
      cachedPathname: "/committed",
      listeners: new Set(),
      navigationSnapshotActiveCount: 0,
    });

    const NavigationRenderContext = getClientNavigationRenderContext();
    if (!NavigationRenderContext) {
      throw new Error("Expected client navigation render context");
    }
    const snapshot = createClientNavigationRenderSnapshot("/stale", {});

    function PathnameProbe() {
      return createElement("span", null, useErrorBoundaryPathname());
    }

    expect(
      renderToString(
        createElement(
          NavigationRenderContext.Provider,
          { value: snapshot },
          createElement(PathnameProbe),
        ),
      ),
    ).toContain("/committed");
  });

  it("provides the public router surface as server-side no-ops", () => {
    expect(ssrAppRouterInstance.bfcacheId).toBe("0");
    expect(() => ssrAppRouterInstance.back()).not.toThrow();
    expect(() => ssrAppRouterInstance.forward()).not.toThrow();
    expect(() => ssrAppRouterInstance.refresh()).not.toThrow();
    expect(() => ssrAppRouterInstance.push("/dashboard")).not.toThrow();
    expect(() => ssrAppRouterInstance.replace("/dashboard")).not.toThrow();
    expect(() => ssrAppRouterInstance.prefetch("/dashboard")).not.toThrow();
  });

  it("retains navigation URL safety checks during SSR", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => ssrAppRouterInstance.push("javascript:alert(1)")).toThrow();
    expect(() => ssrAppRouterInstance.replace("data:text/html,unsafe")).toThrow();
    expect(() => ssrAppRouterInstance.prefetch("vbscript:unsafe")).toThrow();
  });
});
