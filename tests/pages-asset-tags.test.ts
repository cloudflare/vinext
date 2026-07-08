import { describe, it, expect, afterEach } from "vite-plus/test";
import {
  collectAssetTags,
  resolveClientModuleUrl,
  resolveSsrManifest,
  getManifestFilesForModule,
} from "../packages/vinext/src/server/pages-asset-tags.js";
import { setPagesClientAssets } from "../packages/vinext/src/server/pages-client-assets.js";

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

  it("falls back to registered runtime assets when manifest is null", () => {
    const registered = makeManifest({ "a.js": ["b.js"] });
    setPagesClientAssets({ ssrManifest: registered });
    expect(resolveSsrManifest(null)).toBe(registered);
  });

  it("falls back to registered runtime assets when manifest is empty", () => {
    const registered = makeManifest({ "a.js": ["b.js"] });
    setPagesClientAssets({ ssrManifest: registered });
    expect(resolveSsrManifest({})).toBe(registered);
  });

  it("returns null when both manifest and runtime assets are absent", () => {
    setPagesClientAssets(undefined);
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

  it("preserves native ESM identity for client module URLs", () => {
    const m = makeManifest({ "page.tsx": ["page.js"] });
    expect(resolveClientModuleUrl(m, "page.tsx", "", "", "dpl_123")).toBe("/page.js");
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
    setPagesClientAssets(undefined);
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

  // Ported from Next.js: test/production/deployment-id-handling/deployment-id-handling.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/deployment-id-handling/deployment-id-handling.test.ts
  it("keeps JavaScript unqueried while tagging managed stylesheets", () => {
    const result = collectAssetTags({
      manifest: makeManifest({ "page.tsx": ["style.css", "page.js"] }),
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      deploymentId: "dpl_123",
    });

    expect(result).toContain('href="/style.css?dpl=dpl_123"');
    expect(result).toContain('href="/page.js"');
    expect(result).toContain('src="/page.js"');
    expect(result).not.toContain("page.js?dpl=");
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
    setPagesClientAssets({ lazyChunks: ["lazy.js"] });
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

  it("injects the registered client entry first", () => {
    setPagesClientAssets({ clientEntry: "_next/static/entry.js" });
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

  it("injects the registered development client entry without a manifest", () => {
    setPagesClientAssets({ clientEntry: "/@id/__x00__virtual:vinext-client-entry" });
    const result = collectAssetTags({
      manifest: null,
      moduleIds: [],
      scriptNonce: "dev-nonce",
      disableOptimizedLoading: false,
    });

    const tags = parseTags(result);
    expect(tags[0]).toBe(
      '<link rel="modulepreload" nonce="dev-nonce" href="/@id/__x00__virtual:vinext-client-entry" />',
    );
    expect(result).toContain(
      '<script type="module" defer nonce="dev-nonce" src="/@id/__x00__virtual:vinext-client-entry" crossorigin></script>',
    );
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
    setPagesClientAssets(undefined);
    const result = collectAssetTags({
      manifest: null,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
    });
    expect(result).toBe("");
  });

  // basePath + assetPrefix re-anchoring: SSR-manifest values are base-anchored
  // (e.g. "docs/cdn/_next/static/x.js") so the lazy-chunk membership test
  // matches, but the EMITTED href must point where the asset is served.
  // assetPrefix REPLACES basePath for asset URLs.
  it("re-anchors hrefs to a path assetPrefix (not basePath) when both are set", () => {
    // base "/docs/" + assetPrefix "/cdn": on-disk file lives at cdn/_next/static
    // and the SSR-manifest value is base-anchored to docs/cdn/_next/static.
    const manifest = makeManifest({ "page.tsx": ["docs/cdn/_next/static/page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      basePath: "/docs",
      assetPrefix: "/cdn",
    });
    // Served at /cdn/_next/static/... NOT /docs/cdn/_next/static/... (which 404s).
    expect(result).toContain('src="/cdn/_next/static/page.js"');
    expect(result).toContain('href="/cdn/_next/static/page.js"');
    expect(result).not.toContain("/docs/cdn/");
  });

  it("re-anchors hrefs to an absolute assetPrefix when both basePath and assetPrefix are set", () => {
    const manifest = makeManifest({ "page.tsx": ["docs/_next/static/page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      basePath: "/docs",
      assetPrefix: "https://cdn.example.com",
    });
    expect(result).toContain('src="https://cdn.example.com/_next/static/page.js"');
    expect(result).not.toContain("/docs/_next/static/page.js");
  });

  it("re-anchors the injected client entry to the assetPrefix", () => {
    setPagesClientAssets({ clientEntry: "docs/cdn/_next/static/entry.js" });
    const result = collectAssetTags({
      manifest: makeManifest({ "page.tsx": [] }),
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      basePath: "/docs",
      assetPrefix: "/cdn",
    });
    expect(result).toContain('src="/cdn/_next/static/entry.js"');
    expect(result).not.toContain("/docs/cdn/");
  });

  it("keeps the base-anchored href unchanged when no assetPrefix is set", () => {
    // basePath only (assetPrefix falls back to basePath in Next.js): assets ARE
    // served under basePath, so the base-anchored value is already correct.
    const manifest = makeManifest({ "page.tsx": ["docs/_next/static/page.js"] });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      basePath: "/docs",
      assetPrefix: "",
    });
    expect(result).toContain('src="/docs/_next/static/page.js"');
  });

  it("still excludes lazy chunks by their base-anchored key while re-anchoring the href", () => {
    // The membership test must use the base-anchored value, NOT the re-anchored
    // href, so exclusion keeps working under basePath + assetPrefix.
    setPagesClientAssets({ lazyChunks: ["docs/cdn/_next/static/lazy.js"] });
    const manifest = makeManifest({
      "page.tsx": ["docs/cdn/_next/static/page.js", "docs/cdn/_next/static/lazy.js"],
    });
    const result = collectAssetTags({
      manifest,
      moduleIds: ["page.tsx"],
      disableOptimizedLoading: true,
      basePath: "/docs",
      assetPrefix: "/cdn",
    });
    expect(result).toContain('src="/cdn/_next/static/page.js"');
    expect(result).not.toContain("lazy.js");
  });
});
