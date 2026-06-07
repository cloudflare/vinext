import { describe, it, expect, afterEach } from "vite-plus/test";
import {
  collectAssetTags,
  resolveClientModuleUrl,
  resolveSsrManifest,
  getManifestFilesForModule,
} from "../packages/vinext/src/server/pages-asset-tags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(entries: Record<string, string[]>): Record<string, string[]> {
  return entries;
}

// ---------------------------------------------------------------------------
// resolveSsrManifest
// ---------------------------------------------------------------------------

describe("resolveSsrManifest", () => {
  it("returns the provided manifest when non-empty", () => {
    const m = makeManifest({ "page.js": ["chunk.js"] });
    expect(resolveSsrManifest(m)).toBe(m);
  });

  it("falls back to globalThis.__VINEXT_SSR_MANIFEST__ when manifest is null", () => {
    const global = makeManifest({ "a.js": ["b.js"] });
    globalThis.__VINEXT_SSR_MANIFEST__ = global;
    try {
      expect(resolveSsrManifest(null)).toBe(global);
    } finally {
      delete globalThis.__VINEXT_SSR_MANIFEST__;
    }
  });

  it("falls back to globalThis.__VINEXT_SSR_MANIFEST__ when manifest is empty", () => {
    const global = makeManifest({ "a.js": ["b.js"] });
    globalThis.__VINEXT_SSR_MANIFEST__ = global;
    try {
      expect(resolveSsrManifest({})).toBe(global);
    } finally {
      delete globalThis.__VINEXT_SSR_MANIFEST__;
    }
  });

  it("returns null when both manifest and global are absent", () => {
    delete globalThis.__VINEXT_SSR_MANIFEST__;
    expect(resolveSsrManifest(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getManifestFilesForModule
// ---------------------------------------------------------------------------

describe("getManifestFilesForModule", () => {
  it("returns exact match", () => {
    const m = { "pages/about.tsx": ["about.js"] };
    expect(getManifestFilesForModule(m, "pages/about.tsx")).toEqual(["about.js"]);
  });

  it("returns suffix match when exact key absent", () => {
    const m = { "about.tsx": ["about.js"] };
    expect(getManifestFilesForModule(m, "/project/pages/about.tsx")).toEqual(["about.js"]);
  });

  it("returns null for unknown module", () => {
    const m = { "about.tsx": ["about.js"] };
    expect(getManifestFilesForModule(m, "missing.tsx")).toBeNull();
  });

  it("returns null when manifest is null", () => {
    expect(getManifestFilesForModule(null, "page.tsx")).toBeNull();
  });

  it("returns null when moduleId is null", () => {
    const m = { "about.tsx": ["about.js"] };
    expect(getManifestFilesForModule(m, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveClientModuleUrl
// ---------------------------------------------------------------------------

describe("resolveClientModuleUrl", () => {
  it("returns the first .js file with leading slash", () => {
    const m = makeManifest({ "page.tsx": ["page.css", "page.js"] });
    expect(resolveClientModuleUrl(m, "page.tsx")).toBe("/page.js");
  });

  it("normalizes missing leading slash", () => {
    const m = makeManifest({ "page.tsx": ["chunk.js"] });
    expect(resolveClientModuleUrl(m, "page.tsx")).toBe("/chunk.js");
  });

  it("keeps existing leading slash as-is", () => {
    const m = makeManifest({ "page.tsx": ["/static/chunk.js"] });
    expect(resolveClientModuleUrl(m, "page.tsx")).toBe("/static/chunk.js");
  });

  it("returns undefined when module not found", () => {
    const m = makeManifest({ "page.tsx": ["page.js"] });
    expect(resolveClientModuleUrl(m, "missing.tsx")).toBeUndefined();
  });

  it("returns undefined when only css files", () => {
    const m = makeManifest({ "page.tsx": ["style.css"] });
    expect(resolveClientModuleUrl(m, "page.tsx")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectAssetTags — helpers
// ---------------------------------------------------------------------------

function parseTags(html: string): string[] {
  return html ? html.split("\n  ").filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// collectAssetTags — basic JS/CSS injection
// ---------------------------------------------------------------------------

describe("collectAssetTags", () => {
  afterEach(() => {
    delete globalThis.__VINEXT_LAZY_CHUNKS__;
    delete globalThis.__VINEXT_CLIENT_ENTRY__;
  });

  it("emits stylesheet link for css files", () => {
    const manifest = makeManifest({ "page.tsx": ["style.css"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toContain('<link rel="stylesheet"');
    expect(result).toContain('href="/style.css"');
  });

  it("emits modulepreload + script for js files", () => {
    const manifest = makeManifest({ "page.tsx": ["page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toContain('<link rel="modulepreload"');
    expect(result).toContain('<script type="module"');
    expect(result).toContain('src="/page.js"');
  });

  it("adds defer attribute when disableOptimizedLoading is false", () => {
    const manifest = makeManifest({ "page.tsx": ["page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: false,
    });
    expect(result).toContain(" defer");
  });

  it("omits defer attribute when disableOptimizedLoading is true", () => {
    const manifest = makeManifest({ "page.tsx": ["page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).not.toContain(" defer");
  });

  it("deduplicates shared chunks across multiple module IDs", () => {
    const manifest = makeManifest({
      "page.tsx": ["shared.js", "page.js"],
      "_app.tsx": ["shared.js", "app.js"],
    });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx", "_app.tsx"],
      disableOptimizedLoading: true,
    });
    const tags = parseTags(result);
    const preloadTags = tags.filter((t) => t.includes("shared.js"));
    // Should appear exactly twice: once modulepreload, once script
    expect(preloadTags).toHaveLength(2);
  });

  it("includes all manifest assets when moduleIds is empty", () => {
    const manifest = makeManifest({
      "page.tsx": ["page.js"],
      "other.tsx": ["other.js"],
    });
    const result = collectAssetTags({
      manifest,
      moduleIds: [],
      disableOptimizedLoading: true,
    });
    expect(result).toContain("page.js");
    expect(result).toContain("other.js");
  });

  it("skips lazy chunks", () => {
    globalThis.__VINEXT_LAZY_CHUNKS__ = ["lazy.js"];
    const manifest = makeManifest({ "page.tsx": ["lazy.js", "eager.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).not.toContain("lazy.js");
    expect(result).toContain("eager.js");
  });

  it("strips leading slash from manifest values before building href", () => {
    const manifest = makeManifest({ "page.tsx": ["/page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    // Should have exactly one /page.js reference, not //page.js
    expect(result).toContain('href="/page.js"');
    expect(result).not.toContain('href="//page.js"');
  });

  it("injects client entry from globalThis.__VINEXT_CLIENT_ENTRY__ first", () => {
    globalThis.__VINEXT_CLIENT_ENTRY__ = "_next/static/entry.js";
    const manifest = makeManifest({ "page.tsx": ["page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    const tags = parseTags(result);
    // Entry should be first
    expect(tags[0]).toContain("entry.js");
  });

  it("includes shared framework- chunks", () => {
    const manifest = makeManifest({
      vendor: ["framework-abc123.js"],
      "page.tsx": ["page.js"],
    });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toContain("framework-abc123.js");
  });

  it("includes shared vinext- chunks", () => {
    const manifest = makeManifest({
      vendor: ["vinext-runtime.js"],
      "page.tsx": ["page.js"],
    });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toContain("vinext-runtime.js");
  });

  it("applies nonce attribute when provided", () => {
    const manifest = makeManifest({ "page.tsx": ["page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      scriptNonce: "abc123",
      disableOptimizedLoading: true,
    });
    expect(result).toContain('nonce="abc123"');
  });

  it("returns empty string when manifest is null and no globals set", () => {
    delete globalThis.__VINEXT_SSR_MANIFEST__;
    const result = collectAssetTags({
      manifest: null,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toBe("");
  });
});
