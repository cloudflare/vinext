import { describe, expect, it } from "vitest";
import { normalizePagesStaticPathEntry } from "../packages/vinext/src/build/prerender.js";

describe("Pages prerender getStaticPaths entries", () => {
  it("accepts string paths returned from getStaticPaths", () => {
    // Ported from Next.js: test/e2e/prerender-native-module.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender-native-module.test.ts
    expect(normalizePagesStaticPathEntry("/blog/:slug", "/blog/first")).toEqual({
      urlPath: "/blog/first",
      params: {},
    });
  });

  it("keeps object params behavior for dynamic paths", () => {
    expect(normalizePagesStaticPathEntry("/blog/:slug", { params: { slug: "first" } })).toEqual({
      urlPath: "/blog/first",
      params: { slug: "first" },
    });
  });
});
