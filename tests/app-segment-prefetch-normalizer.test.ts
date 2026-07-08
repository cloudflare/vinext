import { describe, it, expect } from "vite-plus/test";
import { extractSegmentPrefetchRsc } from "../packages/vinext/src/server/app-segment-prefetch-normalizer.js";

describe("extractSegmentPrefetchRsc — matching", () => {
  it("matches a root page route tree prefetch", () => {
    expect(extractSegmentPrefetchRsc("/.segments/_tree.segment.rsc")).not.toBeNull();
  });

  it("matches a page route tree prefetch", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.segments/_tree.segment.rsc")).not.toBeNull();
  });

  it("matches a nested page route tree prefetch", () => {
    expect(extractSegmentPrefetchRsc("/blog/posts.segments/_tree.segment.rsc")).not.toBeNull();
  });

  it("matches a root segment prefetch", () => {
    expect(extractSegmentPrefetchRsc("/.segments/_index.segment.rsc")).not.toBeNull();
  });

  it("matches a page segment prefetch", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.segments/__PAGE__.segment.rsc")).not.toBeNull();
  });

  it("matches a nested page segment prefetch", () => {
    expect(extractSegmentPrefetchRsc("/blog/posts.segments/__PAGE__.segment.rsc")).not.toBeNull();
  });

  it("matches a layout segment prefetch", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.segments/_index.segment.rsc")).not.toBeNull();
  });

  it("does not match a regular .rsc URL", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.rsc")).toBeNull();
  });

  it("does not match a regular HTML URL", () => {
    expect(extractSegmentPrefetchRsc("/dashboard")).toBeNull();
  });

  it("does not match a path with partial .segments prefix", () => {
    expect(extractSegmentPrefetchRsc("/my.segments-page")).toBeNull();
  });

  it("does not match a .segment path missing .rsc", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.segments/_tree")).toBeNull();
  });

  it("does not match an empty path", () => {
    expect(extractSegmentPrefetchRsc("")).toBeNull();
  });

  it("matches a deeply nested segment path", () => {
    expect(
      extractSegmentPrefetchRsc("/dashboard/settings.segments/tab/profile/__PAGE__.segment.rsc"),
    ).not.toBeNull();
  });
});

describe("extractSegmentPrefetchRsc", () => {
  it("extracts route tree prefetch for root page", () => {
    const result = extractSegmentPrefetchRsc("/.segments/_tree.segment.rsc");
    expect(result).toEqual({ originalPathname: "/", segmentPath: "/_tree" });
  });

  it("extracts route tree prefetch for a page", () => {
    const result = extractSegmentPrefetchRsc("/dashboard.segments/_tree.segment.rsc");
    expect(result).toEqual({ originalPathname: "/dashboard", segmentPath: "/_tree" });
  });

  it("extracts a page segment prefetch", () => {
    const result = extractSegmentPrefetchRsc("/dashboard.segments/__PAGE__.segment.rsc");
    expect(result).toEqual({ originalPathname: "/dashboard", segmentPath: "/__PAGE__" });
  });

  it("extracts a deeply nested segment prefetch", () => {
    const result = extractSegmentPrefetchRsc(
      "/dashboard/settings.segments/tab/profile/__PAGE__.segment.rsc",
    );
    expect(result).toEqual({
      originalPathname: "/dashboard/settings",
      segmentPath: "/tab/profile/__PAGE__",
    });
  });

  it("extracts a root segment prefetch", () => {
    const result = extractSegmentPrefetchRsc("/.segments/_index.segment.rsc");
    expect(result).toEqual({ originalPathname: "/", segmentPath: "/_index" });
  });

  it("extracts a head request key segment prefetch", () => {
    const result = extractSegmentPrefetchRsc("/.segments/_head.segment.rsc");
    expect(result).toEqual({ originalPathname: "/", segmentPath: "/_head" });
  });

  it("returns null for non-matching pathname", () => {
    expect(extractSegmentPrefetchRsc("/dashboard.rsc")).toBeNull();
  });

  it("returns null for a regular HTML URL", () => {
    expect(extractSegmentPrefetchRsc("/dashboard")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(extractSegmentPrefetchRsc("")).toBeNull();
  });
});
