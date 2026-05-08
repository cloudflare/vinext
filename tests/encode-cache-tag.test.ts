import { describe, expect, it } from "vite-plus/test";
import { encodeCacheTag, encodeCacheTags } from "../packages/vinext/src/utils/encode-cache-tag.js";
import { buildPageCacheTags } from "../packages/vinext/src/server/implicit-tags.js";
import { buildAppPageCacheTags } from "../packages/vinext/src/server/app-page-cache.js";

// Regression: cloudflare/vinext#1138 — non-ASCII cache tags must be encoded at
// construction so storage, comparison, and any downstream HTTP header
// (`x-next-cache-tags`, Cloudflare cache-tag) see the same ASCII-safe form.
// Mirrors vercel/next.js#93601.
describe("encodeCacheTag", () => {
  it("returns ASCII tags unchanged (fast path)", () => {
    expect(encodeCacheTag("posts")).toBe("posts");
    expect(encodeCacheTag("_N_T_/blog/[slug]/page")).toBe("_N_T_/blog/[slug]/page");
    expect(encodeCacheTag("")).toBe("");
  });

  it("percent-encodes non-ASCII runs", () => {
    expect(encodeCacheTag("שלום-עולם")).toBe("%D7%A9%D7%9C%D7%95%D7%9D-%D7%A2%D7%95%D7%9C%D7%9D");
    expect(encodeCacheTag("مرحبا")).toBe("%D9%85%D8%B1%D8%AD%D8%A8%D8%A7");
    expect(encodeCacheTag("こんにちは")).toBe("%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF");
  });

  it("handles surrogate pairs (emoji / non-BMP) without URIError", () => {
    // 🎉 is U+1F389 — a surrogate pair in UTF-16. A naive per-code-unit
    // regex would split the pair and `encodeURIComponent` would throw.
    expect(() => encodeCacheTag("party-🎉")).not.toThrow();
    expect(encodeCacheTag("party-🎉")).toBe("party-%F0%9F%8E%89");
  });

  it("preserves literal %xx sequences in already-encoded input", () => {
    // The fast path leaves ASCII input alone, so pre-encoded tags round-trip
    // losslessly without double-encoding the percent sign.
    expect(encodeCacheTag("100%25-off")).toBe("100%25-off");
    expect(encodeCacheTag("%D7%A9%D7%9C%D7%95%D7%9D")).toBe("%D7%A9%D7%9C%D7%95%D7%9D");
  });

  it("preserves tab and printable ASCII (\\x20-\\x7e)", () => {
    const printable = "\t !\"#$%&'()*+,-./0123456789:;<=>?@ABCXYZ[\\]^_`abcxyz{|}~";
    expect(encodeCacheTag(printable)).toBe(printable);
  });

  it("encodes control characters that would crash header validation", () => {
    // Node's validateHeaderValue rejects bytes outside [\t\x20-\x7e].
    expect(encodeCacheTag("a\nb")).toBe("a%0Ab");
    expect(encodeCacheTag("a\x7fb")).toBe("a%7Fb");
  });

  it("is idempotent on its own output", () => {
    const once = encodeCacheTag("שלום-עולם");
    expect(encodeCacheTag(once)).toBe(once);
  });
});

describe("encodeCacheTags", () => {
  it("encodes each tag in an array", () => {
    expect(encodeCacheTags(["posts", "שלום", "🎉"])).toEqual([
      "posts",
      "%D7%A9%D7%9C%D7%95%D7%9D",
      "%F0%9F%8E%89",
    ]);
  });
});

describe("path-derived tag construction encodes non-ASCII pathnames", () => {
  // Without encoding, a Hebrew pathname stored at render time would never
  // match the tag produced by `revalidatePath('/שלום')` because the latter
  // encodes its input — so the cache would silently fail to invalidate.
  it("buildPageCacheTags encodes non-ASCII pathnames and route segments", () => {
    expect(buildPageCacheTags("/שלום", [], ["שלום"], "page")).toEqual([
      "/%D7%A9%D7%9C%D7%95%D7%9D",
      "_N_T_/%D7%A9%D7%9C%D7%95%D7%9D",
      "_N_T_/layout",
      "_N_T_/%D7%A9%D7%9C%D7%95%D7%9D/layout",
      "_N_T_/%D7%A9%D7%9C%D7%95%D7%9D/page",
    ]);
  });

  it("buildPageCacheTags encodes non-ASCII extra tags from cacheTag()", () => {
    expect(buildPageCacheTags("/blog/hello", ["שלום"], ["blog", "[slug]"], "page")).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/blog/layout",
      "_N_T_/blog/[slug]/layout",
      "_N_T_/blog/[slug]/page",
      "%D7%A9%D7%9C%D7%95%D7%9D",
    ]);
  });

  it("buildAppPageCacheTags encodes non-ASCII pathnames and extra tags", () => {
    expect(buildAppPageCacheTags("/مرحبا", ["🎉"])).toEqual([
      "/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7",
      "_N_T_/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7",
      "_N_T_/layout",
      "_N_T_/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/layout",
      "_N_T_/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/page",
      "%F0%9F%8E%89",
    ]);
  });
});
