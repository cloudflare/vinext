import { describe, it, expect } from "vite-plus/test";
import {
  matchSegmentPrefetchRsc,
  extractSegmentPrefetchRsc,
} from "../packages/vinext/src/server/app-segment-prefetch-normalizer.js";

describe("matchSegmentPrefetchRsc", () => {
  it("matches a root page route tree prefetch", () => {
    expect(matchSegmentPrefetchRsc("/.segments/_tree.segment.rsc")).toBe(true);
  });

  it("matches a page route tree prefetch", () => {
    expect(matchSegmentPrefetchRsc("/dashboard.segments/_tree.segment.rsc")).toBe(true);
  });

  it("matches a nested page route tree prefetch", () => {
    expect(matchSegmentPrefetchRsc("/blog/posts.segments/_tree.segment.rsc")).toBe(true);
  });

  it("matches a root segment prefetch", () => {
    expect(matchSegmentPrefetchRsc("/.segments/_index.segment.rsc")).toBe(true);
  });

  it("matches a page segment prefetch", () => {
    expect(matchSegmentPrefetchRsc("/dashboard.segments/__PAGE__.segment.rsc")).toBe(true);
  });

  it("matches a nested page segment prefetch", () => {
    expect(matchSegmentPrefetchRsc("/blog/posts.segments/__PAGE__.segment.rsc")).toBe(true);
  });

  it("matches a layout segment prefetch", () => {
    expect(matchSegmentPrefetchRsc("/dashboard.segments/_index.segment.rsc")).toBe(true);
  });

  it("does not match a regular .rsc URL", () => {
    expect(matchSegmentPrefetchRsc("/dashboard.rsc")).toBe(false);
  });

  it("does not match a regular HTML URL", () => {
    expect(matchSegmentPrefetchRsc("/dashboard")).toBe(false);
  });

  it("does not match a path with partial .segments prefix", () => {
    expect(matchSegmentPrefetchRsc("/my.segments-page")).toBe(false);
  });

  it("does not match a .segment path missing .rsc", () => {
    expect(matchSegmentPrefetchRsc("/dashboard.segments/_tree")).toBe(false);
  });

  it("does not match an empty path", () => {
    expect(matchSegmentPrefetchRsc("")).toBe(false);
  });

  it("matches a deeply nested segment path", () => {
    expect(
      matchSegmentPrefetchRsc("/dashboard/settings.segments/tab/profile/__PAGE__.segment.rsc"),
    ).toBe(true);
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
