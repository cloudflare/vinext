import { describe, expect, it, afterEach } from "vite-plus/test";
import {
  clearAppRequestContext,
  setAppNavigationContext,
} from "../packages/vinext/src/server/app-request-context.js";
import { setHeadersContext, getHeadersContext } from "../packages/vinext/src/shims/headers.js";
import { getNavigationContext } from "../packages/vinext/src/shims/navigation.js";
import { getRootParam } from "../packages/vinext/src/shims/root-params.js";

describe("clearAppRequestContext", () => {
  afterEach(() => {
    // Ensure clean state for next test.
    clearAppRequestContext();
  });

  it("nulls out all three per-request stores: headers, navigation, root params", () => {
    // Seed all stores with non-null values.
    setHeadersContext({
      headers: new Headers({ host: "example.com" }),
      cookies: new Map(),
    });
    setAppNavigationContext({
      pathname: "/test",
      searchParams: new URLSearchParams("q=1"),
      params: { id: "42" },
    });

    clearAppRequestContext();

    expect(getHeadersContext()).toBeNull();
    expect(getNavigationContext()).toBeNull();
    // Root params are cleared synchronously, so getRootParam resolves to undefined.
    return getRootParam("id").then((val) => {
      expect(val).toBeUndefined();
    });
  });

  it("is idempotent — multiple calls do not throw", () => {
    for (let i = 0; i < 3; i++) {
      clearAppRequestContext();
    }
    expect(getHeadersContext()).toBeNull();
    expect(getNavigationContext()).toBeNull();
  });
});

describe("setAppNavigationContext", () => {
  afterEach(() => {
    clearAppRequestContext();
  });

  it("stores pathname, searchParams, and params so getNavigationContext can read them", () => {
    const searchParams = new URLSearchParams("page=2");
    setAppNavigationContext({
      pathname: "/blog",
      searchParams,
      params: { slug: "hello", id: "42" },
    });

    const ctx = getNavigationContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.pathname).toBe("/blog");
    expect(ctx!.searchParams.get("page")).toBe("2");
    expect(ctx!.params).toEqual({ slug: "hello", id: "42" });
  });

  it("clears both navigation context and root params when ctx is null", () => {
    // Seed state.
    setAppNavigationContext({
      pathname: "/docs",
      searchParams: new URLSearchParams(),
      params: { slug: "readme" },
    });

    setAppNavigationContext(null);

    expect(getNavigationContext()).toBeNull();
    return getRootParam("slug").then((val) => {
      expect(val).toBeUndefined();
    });
  });

  it("clearing navigation does not affect the headers context", () => {
    setHeadersContext({
      headers: new Headers({ host: "example.com" }),
      cookies: new Map([["a", "1"]]),
    });
    setAppNavigationContext({
      pathname: "/a",
      searchParams: new URLSearchParams(),
      params: {},
    });

    setAppNavigationContext(null);

    // Headers should survive the navigation clear — they're independent stores.
    const h = getHeadersContext();
    expect(h).not.toBeNull();
    expect(h!.headers.get("host")).toBe("example.com");
  });
});
