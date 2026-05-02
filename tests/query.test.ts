import { describe, expect, it } from "vite-plus/test";

import { appendSearchParamsToUrl } from "../packages/vinext/src/utils/query.js";

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
