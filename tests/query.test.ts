import { describe, expect, it } from "vite-plus/test";

import {
  appendSearchParamsToUrl,
  mergeRewriteQuery,
  parseQueryString,
} from "../packages/vinext/src/utils/query.js";

describe("mergeRewriteQuery", () => {
  it("preserves original query params when the rewrite target has none", () => {
    const result = mergeRewriteQuery("http://localhost/rewrite-me?hello=world", "/");
    expect(result).toBe("/?hello=world");
  });

  it("returns the rewrite URL unchanged when the original has no query", () => {
    const result = mergeRewriteQuery("http://localhost/rewrite-me", "/target?foo=bar");
    expect(result).toBe("/target?foo=bar");
  });

  it("merges original params with rewrite-target params (rewrite wins on conflicts)", () => {
    const result = mergeRewriteQuery(
      "http://localhost/path?hello=original&keep=this",
      "/target?hello=from-rewrite",
    );
    expect(result).toContain("hello=from-rewrite");
    expect(result).toContain("keep=this");
    expect(result).not.toContain("hello=original");
  });

  it("preserves the rewrite URL's pathname and hash", () => {
    const result = mergeRewriteQuery("http://localhost/path?foo=1", "/target?bar=2#section");
    expect(result).toBe("/target?foo=1&bar=2#section");
  });

  it("supports absolute rewrite URLs (preserves origin)", () => {
    const result = mergeRewriteQuery(
      "http://localhost/path?foo=1",
      "http://localhost/target?bar=2",
    );
    expect(result).toBe("http://localhost/target?foo=1&bar=2");
  });

  it("ignores empty query string after the question mark in original", () => {
    const result = mergeRewriteQuery("http://localhost/path?", "/target");
    expect(result).toBe("/target");
  });

  it("preserves multi-value keys from the original query", () => {
    const result = mergeRewriteQuery("http://localhost/path?tag=a&tag=b", "/target?other=1");
    expect(result).toContain("tag=a");
    expect(result).toContain("tag=b");
    expect(result).toContain("other=1");
  });

  it("uses rewrite-target multi-values when the same key appears in both", () => {
    const result = mergeRewriteQuery(
      "http://localhost/path?tag=orig1&tag=orig2",
      "/target?tag=rw1&tag=rw2",
    );
    // Original tags are removed; rewrite-target tags survive.
    const params = new URLSearchParams(result.slice(result.indexOf("?") + 1));
    expect(params.getAll("tag")).toEqual(["rw1", "rw2"]);
  });

  it("normalizes URL-encoded space (%20) to + via URLSearchParams", () => {
    // URLSearchParams.toString() emits `+` for spaces. Downstream consumers all
    // re-parse via URLSearchParams or new URL(), so this normalization is safe
    // and lossless. This test documents the intentional behavior.
    const result = mergeRewriteQuery("http://localhost/path?foo=hello%20world", "/target");
    expect(result).toBe("/target?foo=hello+world");
    expect(new URLSearchParams(result.slice(result.indexOf("?") + 1)).get("foo")).toBe(
      "hello world",
    );
  });
});

describe("appendSearchParamsToUrl", () => {
  it("adds query params to a path with no existing query", () => {
    const url = appendSearchParamsToUrl("/search", [["q", "vinext"]]);
    expect(url).toBe("/search?q=vinext");
  });

  it("preserves existing query params when appending new ones", () => {
    const url = appendSearchParamsToUrl("/search?lang=en", [["q", "vinext"]]);
    expect(url).toBe("/search?lang=en&q=vinext");
  });

  it("preserves duplicate keys from the existing query string", () => {
    const url = appendSearchParamsToUrl("/search?tag=a&tag=b", [["tag", "c"]]);
    expect(url).toBe("/search?tag=a&tag=b&tag=c");
  });

  it("preserves hash fragments after appending query params", () => {
    const url = appendSearchParamsToUrl("/search?lang=en#results", [["q", "vinext"]]);
    expect(url).toBe("/search?lang=en&q=vinext#results");
  });

  it("preserves hashes when the base URL has no existing query string", () => {
    const url = appendSearchParamsToUrl("/search#results", [["q", "vinext"]]);
    expect(url).toBe("/search?q=vinext#results");
  });

  it("preserves absolute URLs", () => {
    const url = appendSearchParamsToUrl("https://example.com/search?lang=en#results", [
      ["q", "vinext"],
    ]);
    expect(url).toBe("https://example.com/search?lang=en&q=vinext#results");
  });

  it("returns the original URL when there are no params to append", () => {
    const url = appendSearchParamsToUrl("/search?lang=en#results", []);
    expect(url).toBe("/search?lang=en#results");
  });

  it("supports query-only relative URLs", () => {
    const url = appendSearchParamsToUrl("?lang=en", [["q", "vinext"]]);
    expect(url).toBe("?lang=en&q=vinext");
  });
});

describe("parseQueryString", () => {
  it("returns an empty object when there is no query string", () => {
    expect(parseQueryString("/about")).toEqual({});
  });

  it("parses simple key=value pairs", () => {
    expect(parseQueryString("/about?foo=bar")).toEqual({ foo: "bar" });
  });

  it("promotes duplicate keys to arrays", () => {
    expect(parseQueryString("/search?tag=a&tag=b")).toEqual({ tag: ["a", "b"] });
  });

  // Regression for #1471: Pages Router `<Link>` strips query string from href.
  // When a page is requested as `/linker?href=/about?hello=world`, the value of
  // the `href` query param is `/about?hello=world` (RFC 3986 only treats the
  // first `?` as a path/query separator). Splitting the URL on every `?` would
  // drop the embedded query from the value and cause `<Link href={...}>` to
  // render without the trailing query string.
  it("preserves embedded query strings in values when the URL has multiple ?", () => {
    expect(parseQueryString("/linker?href=/about?hello=world")).toEqual({
      href: "/about?hello=world",
    });
  });

  it("preserves embedded query strings whose value has a trailing-slash path", () => {
    expect(parseQueryString("/linker?href=/about/?hello=world")).toEqual({
      href: "/about/?hello=world",
    });
  });

  it("stops at the URL hash fragment", () => {
    expect(parseQueryString("/about?foo=bar#section")).toEqual({ foo: "bar" });
  });
});
