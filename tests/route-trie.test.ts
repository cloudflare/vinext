import { describe, it, expect } from "vite-plus/test";
import { buildRouteTrie, trieMatch } from "../packages/vinext/src/routing/route-trie.js";

type TestRoute = {
  pattern: string;
  patternParts: string[];
};

function r(pattern: string): TestRoute {
  const parts = pattern === "/" ? [] : pattern.split("/").filter(Boolean);
  // Convert parts to the internal format: [slug] → :slug, [...slug] → :slug+, [[...slug]] → :slug*
  // But our test routes already use the internal :param format, so just use as-is
  return { pattern, patternParts: parts };
}

describe("buildRouteTrie + trieMatch", () => {
  describe("basic matching", () => {
    it("matches root route", () => {
      const trie = buildRouteTrie([r("/")]);
      const result = trieMatch(trie, []);
      expect(result).not.toBeNull();
      expect(result!.route.pattern).toBe("/");
      expect(result!.params).toEqual({});
    });

    it("matches static routes", () => {
      const routes = [r("/"), r("/about"), r("/blog")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["about"])!.route.pattern).toBe("/about");
      expect(trieMatch(trie, ["blog"])!.route.pattern).toBe("/blog");
      expect(trieMatch(trie, [])!.route.pattern).toBe("/");
    });

    it("matches nested static routes", () => {
      const routes = [r("/blog/posts/featured")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["blog", "posts", "featured"])!.route.pattern).toBe(
        "/blog/posts/featured",
      );
      expect(trieMatch(trie, ["blog", "posts"])).toBeNull();
      expect(trieMatch(trie, ["blog"])).toBeNull();
    });

    it("returns null for no match", () => {
      const routes = [r("/about")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["contact"])).toBeNull();
      expect(trieMatch(trie, ["about", "team"])).toBeNull();
    });
  });

  describe("dynamic segments", () => {
    it("matches single dynamic segment", () => {
      const routes = [r("/blog/:slug")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["blog", "hello-world"]);
      expect(result).not.toBeNull();
      expect(result!.route.pattern).toBe("/blog/:slug");
      expect(result!.params).toEqual({ slug: "hello-world" });
    });

    it("matches multiple dynamic segments", () => {
      const routes = [r("/:a/:b/:c")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["x", "y", "z"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ a: "x", b: "y", c: "z" });
    });

    it("does not match dynamic segment with extra path", () => {
      const routes = [r("/blog/:slug")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["blog", "hello", "extra"])).toBeNull();
    });

    it("does not match dynamic segment with missing segment", () => {
      const routes = [r("/blog/:slug")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["blog"])).toBeNull();
    });
  });

  describe("catch-all routes", () => {
    it("matches catch-all with one segment", () => {
      const routes = [r("/docs/:path+")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["docs", "intro"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ path: ["intro"] });
    });

    it("matches catch-all with multiple segments", () => {
      const routes = [r("/docs/:path+")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["docs", "api", "reference", "v2"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ path: ["api", "reference", "v2"] });
    });

    it("does not match catch-all with zero segments", () => {
      const routes = [r("/docs/:path+")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["docs"])).toBeNull();
    });
  });

  describe("optional catch-all routes", () => {
    it("matches optional catch-all with zero segments without materializing the param", () => {
      // Next.js route-regex makes the optional catch-all capture group optional, and
      // route-matcher only writes params for defined capture groups:
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-regex.ts
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts
      const routes = [r("/docs/:path*")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["docs"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
    });

    it("matches optional catch-all with one segment", () => {
      const routes = [r("/docs/:path*")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["docs", "intro"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ path: ["intro"] });
    });

    it("matches optional catch-all with multiple segments", () => {
      const routes = [r("/docs/:path*")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["docs", "api", "ref"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ path: ["api", "ref"] });
    });

    it("matches root-level optional catch-all with zero segments without materializing the param", () => {
      const routes = [r("/:path*")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, []);
      expect(result).not.toBeNull();
      expect(result!.route.pattern).toBe("/:path*");
      expect(result!.params).toEqual({});
    });
  });

  describe("priority / precedence", () => {
    it("static wins over dynamic", () => {
      // Pre-sorted: static first
      const routes = [r("/blog/about"), r("/blog/:slug")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["blog", "about"])!.route.pattern).toBe("/blog/about");
      expect(trieMatch(trie, ["blog", "other"])!.route.pattern).toBe("/blog/:slug");
    });

    it("dynamic wins over catch-all", () => {
      const routes = [r("/blog/:id/comments"), r("/blog/:path+")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["blog", "42", "comments"])!.route.pattern).toBe("/blog/:id/comments");
      expect(trieMatch(trie, ["blog", "42", "comments"])!.params).toEqual({
        id: "42",
      });
    });

    it("catch-all wins over optional catch-all", () => {
      const routes = [r("/docs/:path+"), r("/docs/:slug*")];
      const trie = buildRouteTrie(routes);

      // With segments: catch-all wins
      expect(trieMatch(trie, ["docs", "intro"])!.route.pattern).toBe("/docs/:path+");
      // With zero segments: only optional catch-all matches
      expect(trieMatch(trie, ["docs"])!.route.pattern).toBe("/docs/:slug*");
    });
  });

  describe("backtracking", () => {
    it("backtracks from dynamic dead-end to catch-all", () => {
      const routes = [r("/blog/:id/comments"), r("/blog/:path+")];
      const trie = buildRouteTrie(routes);

      // /blog/42/photos → dynamic :id matches "42", but "photos" has no match
      // → backtrack to catch-all :path+ which matches ["42", "photos"]
      const result = trieMatch(trie, ["blog", "42", "photos"]);
      expect(result).not.toBeNull();
      expect(result!.route.pattern).toBe("/blog/:path+");
      expect(result!.params).toEqual({ path: ["42", "photos"] });
    });

    it("backtracks from static dead-end to dynamic", () => {
      const routes = [r("/api/users/me"), r("/api/:resource/:id")];
      const trie = buildRouteTrie(routes);

      // /api/users/me is fully static. /api/:resource/:id is fully dynamic.
      // For /api/users/123: api → users matches the static branch, but 123 ≠ "me",
      // so that branch is a dead-end and the matcher backtracks to api → :resource → :id.
      const result = trieMatch(trie, ["api", "users", "123"]);
      expect(result).not.toBeNull();
      expect(result!.route.pattern).toBe("/api/:resource/:id");
      expect(result!.params).toEqual({ resource: "users", id: "123" });

      // /api/users/me should still prefer the more specific static route
      const meResult = trieMatch(trie, ["api", "users", "me"]);
      expect(meResult!.route.pattern).toBe("/api/users/me");
    });

    it("backtracks multiple levels", () => {
      const routes = [
        r("/a/b/c/d"), // most specific
        r("/a/b/:x"), // dynamic at depth 3
        r("/a/:y+"), // catch-all at depth 2
      ];
      const trie = buildRouteTrie(routes);

      // /a/b/c/d → exact static match
      expect(trieMatch(trie, ["a", "b", "c", "d"])!.route.pattern).toBe("/a/b/c/d");

      // /a/b/c → static a -> static b -> static c -> no route (d is missing)
      //       → backtrack: a -> b -> :x matches "c" → has route ✓
      expect(trieMatch(trie, ["a", "b", "c"])!.route.pattern).toBe("/a/b/:x");
      expect(trieMatch(trie, ["a", "b", "c"])!.params).toEqual({ x: "c" });

      // /a/b/c/e → static a -> b -> c -> no "e" → backtrack to a -> b -> :x -> only matches 1 segment
      //         → backtrack to a -> :y+ matches ["b", "c", "e"]
      expect(trieMatch(trie, ["a", "b", "c", "e"])!.route.pattern).toBe("/a/:y+");
      expect(trieMatch(trie, ["a", "b", "c", "e"])!.params).toEqual({
        y: ["a", "b", "c", "e"].slice(1),
      });
    });
  });

  describe("deeply nested routes", () => {
    it("handles 5+ segment routes", () => {
      const routes = [r("/a/b/c/d/e/f")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["a", "b", "c", "d", "e", "f"])!.route.pattern).toBe("/a/b/c/d/e/f");
      expect(trieMatch(trie, ["a", "b", "c", "d", "e"])).toBeNull();
    });
  });

  describe("root-level catch-alls", () => {
    it("matches root-level optional catch-all", () => {
      const routes = [r("/"), r("/:path*")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, [])!.route.pattern).toBe("/");
      expect(trieMatch(trie, ["anything"])!.route.pattern).toBe("/:path*");
      expect(trieMatch(trie, ["a", "b"])!.params).toEqual({ path: ["a", "b"] });
    });

    it("matches root-level catch-all", () => {
      const routes = [r("/"), r("/:path+")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, [])!.route.pattern).toBe("/");
      expect(trieMatch(trie, ["anything"])!.route.pattern).toBe("/:path+");
    });
  });

  describe("parity with linear matchPattern", () => {
    // This is the critical parity test: generate many routes and URLs,
    // run both the trie and the linear scan, assert identical results.

    function linearMatchPattern(
      urlParts: string[],
      patternParts: string[],
    ): Record<string, string | string[]> | null {
      const params: Record<string, string | string[]> = Object.create(null);
      for (let i = 0; i < patternParts.length; i++) {
        const pp = patternParts[i];
        if (pp.endsWith("+")) {
          if (i !== patternParts.length - 1) return null;
          const paramName = pp.slice(1, -1);
          const remaining = urlParts.slice(i);
          if (remaining.length === 0) return null;
          params[paramName] = remaining;
          return params;
        }
        if (pp.endsWith("*")) {
          if (i !== patternParts.length - 1) return null;
          const paramName = pp.slice(1, -1);
          const remaining = urlParts.slice(i);
          if (remaining.length > 0) {
            params[paramName] = remaining;
          }
          return params;
        }
        if (pp.startsWith(":")) {
          const paramName = pp.slice(1);
          if (i >= urlParts.length) return null;
          params[paramName] = urlParts[i];
          continue;
        }
        if (i >= urlParts.length || urlParts[i] !== pp) return null;
      }
      if (urlParts.length !== patternParts.length) return null;
      return params;
    }

    function linearMatchRoute(
      urlParts: string[],
      routes: TestRoute[],
    ): { route: TestRoute; params: Record<string, string | string[]> } | null {
      for (const route of routes) {
        const params = linearMatchPattern(urlParts, route.patternParts);
        if (params !== null) return { route, params };
      }
      return null;
    }

    // Routes are pre-sorted by precedence (static > dynamic > catch-all > optional catch-all),
    // which is how the real codebase provides them. The trie and linear scan must agree
    // when routes are in this order. Note: all dynamic segments at the same depth
    // must share the same param name (enforced by validateRoutePatterns in production).
    const parityRoutes: TestRoute[] = [
      // Static routes (sorted alphabetically, shorter first)
      r("/"),
      r("/about"),
      r("/a/b/c/d/e"),
      r("/api/health"),
      r("/api/users/me"),
      r("/blog"),
      r("/blog/archive"),
      r("/blog/featured"),
      r("/settings/notifications"),
      r("/settings/profile"),
      // Static prefix + dynamic suffix
      r("/api/users/:id"),
      r("/blog/:slug"),
      r("/products/:category/:id"),
      // Static prefix + catch-all
      r("/docs/:path+"),
      r("/files/:rest+"),
      // Static prefix + optional catch-all
      r("/shop/:path*"),
      r("/wiki/:slug*"),
    ];

    const testUrls: string[][] = [
      [],
      ["about"],
      ["blog"],
      ["blog", "featured"],
      ["blog", "archive"],
      ["blog", "hello-world"],
      ["blog", "my-post"],
      ["api", "health"],
      ["api", "users", "me"],
      ["api", "users", "42"],
      ["api", "users", "abc"],
      ["settings", "profile"],
      ["settings", "notifications"],
      ["settings", "other"],
      ["a", "b", "c", "d", "e"],
      ["products", "electronics", "123"],
      ["products", "books", "456"],
      ["docs", "intro"],
      ["docs", "api", "reference"],
      ["docs", "api", "reference", "v2"],
      ["files", "images", "photo.jpg"],
      ["shop"],
      ["shop", "electronics"],
      ["shop", "electronics", "phones"],
      ["wiki"],
      ["wiki", "page"],
      ["wiki", "nested", "page"],
      ["nonexistent"],
      ["a"],
      ["a", "b"],
      ["deeply", "nested", "path", "that", "matches", "nothing"],
    ];

    const trie = buildRouteTrie(parityRoutes);

    for (const urlParts of testUrls) {
      const urlStr = "/" + urlParts.join("/");
      it(`parity: ${urlStr}`, () => {
        const trieResult = trieMatch(trie, urlParts);
        const linearResult = linearMatchRoute(urlParts, parityRoutes);

        if (linearResult === null) {
          expect(trieResult).toBeNull();
        } else {
          expect(trieResult).not.toBeNull();
          expect(trieResult!.route.pattern).toBe(linearResult.route.pattern);

          // Compare params — normalize for comparison
          const trieParams = { ...trieResult!.params };
          const linearParams = { ...linearResult.params };
          expect(trieParams).toEqual(linearParams);
        }
      });
    }
  });

  describe("edge cases", () => {
    it("handles param names with hyphens", () => {
      const routes = [r("/blog/:post-id")];
      const trie = buildRouteTrie(routes);

      const result = trieMatch(trie, ["blog", "42"]);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ "post-id": "42" });
    });

    it("handles empty trie (no routes)", () => {
      const trie = buildRouteTrie([]);
      expect(trieMatch(trie, [])).toBeNull();
      expect(trieMatch(trie, ["anything"])).toBeNull();
    });

    it("handles single root route only", () => {
      const trie = buildRouteTrie([r("/")]);
      expect(trieMatch(trie, [])!.route.pattern).toBe("/");
      expect(trieMatch(trie, ["anything"])).toBeNull();
    });

    it("static route with same prefix as dynamic does not leak", () => {
      const routes = [r("/api/v1"), r("/api/:version")];
      const trie = buildRouteTrie(routes);

      expect(trieMatch(trie, ["api", "v1"])!.route.pattern).toBe("/api/v1");
      expect(trieMatch(trie, ["api", "v2"])!.route.pattern).toBe("/api/:version");
    });

    it("first route wins for duplicate patterns", () => {
      const route1: TestRoute = { pattern: "/first", patternParts: ["first"] };
      const route2: TestRoute = { pattern: "/first", patternParts: ["first"] };
      const trie = buildRouteTrie([route1, route2]);

      const result = trieMatch(trie, ["first"]);
      expect(result!.route).toBe(route1);
    });
  });

  // Ported from Next.js: route-matcher.ts decodeURIComponent behaviour
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts#L25-L27
  // Also: test/production/pages-dir/production/test/index.test.ts "should handle failed param decoding"
  // https://github.com/vercel/next.js/blob/canary/test/production/pages-dir/production/test/index.test.ts#L1082
  describe("param decoding", () => {
    it("decodes %2F, %23, %3F in dynamic segment params without splitting segments", () => {
      // /files/[name] matching /files/a%2Fb → param "a/b" (not "a", "b")
      const trie = buildRouteTrie([r("/files/:name")]);
      expect(trieMatch(trie, ["files", "a%2Fb"])!.params).toEqual({ name: "a/b" });
      expect(trieMatch(trie, ["files", "a%23b"])!.params).toEqual({ name: "a#b" });
      expect(trieMatch(trie, ["files", "a%3Fb"])!.params).toEqual({ name: "a?b" });
    });

    it("decodes each element of catch-all and optional catch-all arrays individually", () => {
      const catchAllTrie = buildRouteTrie([r("/docs/:rest+")]);
      expect(trieMatch(catchAllTrie, ["docs", "a%2Fb", "c%23d"])!.params).toEqual({
        rest: ["a/b", "c#d"],
      });

      const optionalTrie = buildRouteTrie([r("/docs/:rest*")]);
      expect(trieMatch(optionalTrie, ["docs", "a%2Fb", "c%23d"])!.params).toEqual({
        rest: ["a/b", "c#d"],
      });
    });

    it("preserves malformed percent escapes without throwing", () => {
      // Next.js throws DecodeError (400) on malformed, but vinext's
      // normalization layer already validates percent-encoding. The matcher
      // layer preserves un-decodable values rather than crashing.
      const trie = buildRouteTrie([r("/files/:name")]);
      expect(trieMatch(trie, ["files", "a%GGb"])!.params).toEqual({ name: "a%GGb" });
    });

    it("applies exactly one decodeURIComponent pass (double-encoded stays single-encoded)", () => {
      const trie = buildRouteTrie([r("/files/:name")]);
      expect(trieMatch(trie, ["files", "a%252Fb"])!.params).toEqual({ name: "a%2Fb" });
    });
  });
});
