import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  configSourceError,
  matchConfigPattern,
  matchHeaders,
  matchRedirect,
  matchRewrite,
  requestContextFromRequest,
} from "../packages/vinext/src/config/config-matchers.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { clientRewriteAppendsParams } from "../packages/vinext/src/client/client-rewrite-params.js";
import { execConfigSource } from "../packages/vinext/src/config/config-source.js";

// next.config.js redirects/rewrites/headers sources are compiled the way
// Next.js 16 does at runtime: path-to-regexp 6 (`strict`, `delimiter: "/"`,
// case-insensitive) plus `modifyRouteRegex`'s optional trailing slash.
// The oracle below is Next's own compiled path-to-regexp and getPathMatch.

type NextKey = { name: string | number; prefix: string; suffix: string; modifier: string };
type NextParams = Record<string, string | string[] | undefined>;

const require = createRequire(import.meta.url);
const { pathToRegexp } = require("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (source: string, keys: NextKey[], options: object) => RegExp;
};
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match") as {
  getPathMatch: (source: string, options: object) => (pathname: string) => NextParams | false;
};
const { modifyRouteRegex } = require("next/dist/lib/redirect-status") as {
  modifyRouteRegex: (regex: string) => string;
};
const { tryToParsePath } = require("next/dist/lib/try-to-parse-path") as {
  tryToParsePath: (route: string) => { error?: unknown; regexStr?: string };
};
const loadCustomRoutes = require("next/dist/lib/load-custom-routes").default as (
  config: object,
) => Promise<unknown>;

/**
 * Next.js params in vinext's representation: repeated params keep the
 * captured string (`a/b` rather than `["a", "b"]`) and a missing optional
 * param is `""`.
 */
function nextMatch(source: string, pathname: string): Record<string, string> | null | "throws" {
  let match: (pathname: string) => NextParams | false;
  const keys: NextKey[] = [];
  try {
    pathToRegexp(source, keys, { delimiter: "/", strict: true, sensitive: false });
    match = getPathMatch(source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
    });
  } catch {
    return "throws";
  }
  const params = match(pathname);
  if (!params) return null;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key.name !== "string") continue;
    const value = params[key.name];
    result[key.name] = Array.isArray(value) ? value.join(key.prefix + key.suffix) : (value ?? "");
  }
  return result;
}

const SOURCES = [
  "/{ab:id}+",
  "/x{--:id}+",
  "/",
  "/about",
  "/about/",
  "/Case/Path",
  "/blog/:slug",
  "/blog/:slug.md",
  "/blog/:slug.html",
  "/blog-:slug",
  "/:a-:b",
  "/user/:id.:format",
  "/:auth-method",
  "/docs/:path*",
  "/docs/:path+",
  "/files/:path*.md",
  "/files/:path+.md",
  "/:path*",
  "/:path+/:tail?",
  "/:path*/:tail?",
  "/:a/:b?",
  "/x/:locale?",
  "/x/:locale(en|sv)?",
  "/:locale(en|sv)?",
  "/:locale(en|sv)?/about",
  "/:locale(en|sv)?/settings/:path*",
  "/:locale(en|sv)?/:slug(\\d+)?",
  "/:locale/files/:path*",
  "/docs/:rest(.*)",
  "/:path(.*)",
  "/(.*)",
  "/api/(.*)",
  "/foo/(bar|baz)/:id",
  "/n/:id(\\d+)",
  "/n/:id(\\d+)*",
  "/n/:id(\\d+)+",
  "/v/:version(v\\d+)/:rest*",
  "/static/:file(.*\\.js)",
  "/foo{-:bar}?",
  "/foo{-:bar}+",
  "/files/:name{.:ext}?",
  "/a\\:b",
  "/foo\\/:bar(\\d+)?",
  "/:a(\\d+)?-:b",
  "/with space",
  "/%E2%82%AC/:slug",
  "/:id?/:id?",
  "/:id/:id",
  "/:id/:id*",
  "/:id/:id+",
  "/{-:a([a-z]+)-}+",
  // Plain literal text to path-to-regexp.
  "/foo[bar]",
  "/a|b",
  "/foo)bar",
  // Linear: each backreference reads what its param captured, and `(?!a|b)a`
  // and `(?!é|x)é` never match.
  "/:a(x)/:id(y\\1)+",
  "/:id(x(?:(?!a|b)a|a))+",
  "/:a(a)/:id(\\1+)",
  "/:a(x+)/:id(y\\1)+",
  "/:a(a|bb)/:id(\\1+)",
  "/:id(x(?:(?!é|x)é|é))+",
  // Invalid in path-to-regexp; Next.js fails the build for these.
  "/:a:b",
  "/foo:path*",
  "/:id(a(b))",
  "/:",
  "/(",
];

const PATHNAMES = [
  "/foo)bar",
  "/FOO)BAR",
  "/bb/bbbb",
  "/a/aab",
  "/foo[bar]",
  "/FOO[BAR]",
  "/a|b",
  "/x/yx/yx",
  "/x/yx/y",
  "/xa/xa",
  "/a/aaa",
  "/xx/yxx/yxx",
  "/xx/yxx/yx",
  "/xé/xé",
  "/abxabY",
  "/abxaab",
  "/abab",
  "/x--a--b",
  "/x--a---b",
  "/",
  "//",
  "/about",
  "/about/",
  "/ABOUT",
  "/about//",
  "/case/path",
  "/blog/x",
  "/blog/x/",
  "/blog/x.md",
  "/blog/x.md/",
  "/blog/.md",
  "/blog/x.y.md",
  "/blog/x.html",
  "/blog-hello",
  "/blog-",
  "/a-b",
  "/a-b-c",
  "/a-",
  "/user/1.json",
  "/user/1",
  "/user/1.2.json",
  "/auth-method",
  "/auth",
  "/docs",
  "/docs/",
  "/docs/a",
  "/docs/a/",
  "/docs/a/b",
  "/docs//a",
  "/files/.md",
  "/files/a.md",
  "/files/a/b.md",
  "/files/a/b.md/",
  "/files/readme",
  "/files/readme.txt",
  "/files/archive.tar.gz",
  "/x",
  "/x/",
  "/x/en",
  "/x/EN",
  "/x/de",
  "/x/en/y",
  "/en",
  "/SV",
  "/en/about",
  "/SV/about",
  "/de/about",
  "/settings",
  "/settings/a",
  "/sv/settings",
  "/sv/settings/a/b",
  "/en/12",
  "/12",
  "/en/files/a/b",
  "/foo/bar/1",
  "/foo/qux/1",
  "/api",
  "/api/",
  "/api/x/y",
  "/n/12",
  "/n/12/34",
  "/n/",
  "/n/ab",
  "/v/v2",
  "/v/v2/a/b",
  "/v/x",
  "/static/a.js",
  "/static/a/b.js",
  "/static/a.css",
  "/foo",
  "/foo-x",
  "/foo-x-y",
  "/foo-",
  "/files/name",
  "/a:b",
  "/foo/1",
  "/1-x",
  "/-x",
  "/with space",
  "/%E2%82%AC/x",
  "/a/b/c",
  "/-a-",
  "/-a--b-",
  "/-a-b-",
];

describe("config sources match like Next.js", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches the same pathnames with the same params as Next.js path-to-regexp", () => {
    for (const source of SOURCES) {
      for (const pathname of PATHNAMES) {
        const expected = nextMatch(source, pathname);
        const actual = matchConfigPattern(pathname, source);
        const label = `${source} ← ${pathname}`;
        if (expected === "throws") expect(actual, label).toBeNull();
        else expect(actual === null ? null : { ...actual }, label).toEqual(expected);
      }
    }
  });

  it("rejects sources path-to-regexp cannot compile with a warning", () => {
    // Distinct from SOURCES so the compile cache is cold and the warning fires.
    for (const source of ["/:c:d", "/bar:path+", "/:id(c(d))", "/x/:", "/x/("]) {
      expect(nextMatch(source, "/x"), source).toBe("throws");
      expect(matchConfigPattern("/x", source), source).toBeNull();
      expect(console.warn, source).toHaveBeenLastCalledWith(
        expect.stringContaining(`Ignoring invalid next.config.js source "${source}"`),
      );
    }
  });

  it("ignores sources whose custom pattern is not a valid RegExp instead of throwing", () => {
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    const sources = ["/:id(a{2,1})", "/:id(*)", "/:id(a**)", "/:a((?<n>x))/:b((?<n>y))"];
    for (const source of sources) {
      expect(nextMatch(source, "/x"), source).toBe("throws");
      expect(matchConfigPattern("/x", source), source).toBeNull();
      expect(console.warn, source).toHaveBeenLastCalledWith(
        expect.stringContaining(`Ignoring invalid next.config.js source "${source}"`),
      );
    }
    const headers = sources.map((source) => ({ source, headers: [{ key: "x", value: "1" }] }));
    expect(
      matchHeaders("/x", [...headers, { source: "/x", headers: [{ key: "y", value: "1" }] }], ctx),
    ).toEqual([{ key: "y", value: "1" }]);
  });
  it("runs custom patterns as written, like Next.js", () => {
    // Next.js does not check custom param patterns for catastrophic
    // backtracking, so these compile and match as written.
    const sources = [
      "/:a((?:a+)+)",
      "/:a(a*a*)b",
      "/:a(.*)*/end",
      "/{a:id(a+)}+X",
      "/x{-:id([a-z-]+)}+",
      "/:id(a|aa?)+",
      "/:a(a+):b(a+):c(a+)",
      "/blog/:slug([a-z0-9]+(?:-[a-z0-9]+)*)",
    ];
    const pathnames = ["/aaa", "/aab", "/a/b/end", "/aaX", "/x-a-b", "/a/aa", "/blog/a-b", "/b"];
    for (const source of sources) {
      for (const pathname of pathnames) {
        const expected = nextMatch(source, pathname);
        expect(expected, source).not.toBe("throws");
        const actual = matchConfigPattern(pathname, source);
        expect(actual === null ? null : { ...actual }, `${source} ← ${pathname}`).toEqual(expected);
      }
    }
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("Pages client sync rewrites", () => {
  it("defers rewrites that append unused source params to the query", () => {
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    // The sync path only substitutes params, so it defers exactly the
    // rewrites where the server also appends them to the query.
    for (const [source, destination, pathname, server, defers] of [
      ["/From/:id", "/target", "/from/123", "/target?id=123", true],
      ["/from/:id", "/target?x=1", "/from/123", "/target?x=1&id=123", true],
      // A param the destination query already names is not appended.
      ["/from/:id", "/target?id=:id", "/from/123", "/target?id=123", false],
      ["/from/:id", "/target?id=fixed", "/from/123", "/target?id=fixed", false],
      ["/from/:id/:tab", "/target?id=:id", "/from/1/2", "/target?id=1&tab=2", true],
      ["/from/:id", "/target/:id", "/from/123", "/target/123", false],
      ["/from/:id/:tab", "/target/:id", "/from/1/2", "/target/1", false],
      ["/docs/:path*", "/d/:path*", "/docs/a/b", "/d/a/b", false],
      ["/about", "/target", "/about", "/target", false],
      // The server never appends the i18n locale param.
      [
        "/:nextInternalLocale/blog/:slug",
        "/:nextInternalLocale/posts",
        "/en/blog/hello",
        "/en/posts?slug=hello",
        true,
      ],
    ] as const) {
      expect(matchRewrite(pathname, [{ source, destination }], ctx), source).toBe(server);
      const params = matchConfigPattern(pathname, source)!;
      expect(clientRewriteAppendsParams(destination, params), source).toBe(defers);
    }
    // An empty `*` is unmatched, so the server still appends `id`; the sync
    // path defers any rewrite with unmatched params.
    expect(
      matchRewrite(
        "/from/foo",
        [{ source: "/From/:id/:rest*", destination: "/target/:rest*" }],
        ctx,
      ),
    ).toBe("/target/?id=foo");
    expect(execConfigSource("/from/foo", "/From/:id/:rest*")?.unmatched).toEqual(["rest"]);
  });
});

describe("config source matching regressions", () => {
  it("returns a null-prototype params object", () => {
    const params = matchConfigPattern("/foo/x", "/foo/:__proto__");
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.hasOwn(params!, "__proto__")).toBe(true);
    expect(params!["__proto__"]).toBe("x");
  });

  it("captures a regex param across segments", () => {
    expect(matchConfigPattern("/docs/a/b", "/docs/:rest(.*)")).toEqual({ rest: "a/b" });
    expect(matchConfigPattern("/docs/", "/docs/:rest(.*)")).toEqual({ rest: "" });
    expect(matchConfigPattern("/api/x/y", "/api/(.*)")).toEqual({});
  });

  it("drops the slash before an optional or zero-or-more param", () => {
    expect(matchConfigPattern("/x", "/x/:locale?")).toEqual({ locale: "" });
    expect(matchConfigPattern("/x/en", "/x/:locale?")).toEqual({ locale: "en" });
    expect(matchConfigPattern("/settings", "/:locale(en|sv)?/settings/:path*")).toEqual({
      locale: "",
      path: "",
    });
    expect(matchConfigPattern("/sv/settings/a/b", "/:locale(en|sv)?/settings/:path*")).toEqual({
      locale: "sv",
      path: "a/b",
    });
    expect(matchConfigPattern("/de/settings", "/:locale(en|sv)?/settings/:path*")).toBeNull();
    expect(matchConfigPattern("/", "/:locale(en|sv)?")).toEqual({ locale: "" });
  });

  it("does not expose unnamed groups as params", () => {
    expect(matchConfigPattern("/foo/bar/1", "/foo/(bar|baz)/:id")).toEqual({ id: "1" });
  });

  it("treats `.` before a param as an optional-capable prefix", () => {
    expect(matchConfigPattern("/files/name", "/files/:name{.:ext}?")).toEqual({
      name: "name",
      ext: "",
    });
    expect(matchConfigPattern("/files/archive.tar.gz", "/files/:name{.:ext}?")).toEqual({
      name: "archive.tar",
      ext: "gz",
    });
    expect(matchConfigPattern("/user/1.json", "/user/:id.:format")).toEqual({
      id: "1",
      format: "json",
    });
  });

  it("repeats a constrained param per segment", () => {
    expect(matchConfigPattern("/n/12/34", "/n/:id(\\d+)*")).toEqual({ id: "12/34" });
    expect(matchConfigPattern("/n/12/ab", "/n/:id(\\d+)*")).toBeNull();
    expect(matchConfigPattern("/n", "/n/:id(\\d+)*")).toEqual({ id: "" });
    expect(matchConfigPattern("/n", "/n/:id(\\d+)+")).toBeNull();
  });

  it("requires a non-empty segment before a literal suffix", () => {
    expect(matchConfigPattern("/files/a/b.md", "/files/:path*.md")).toEqual({ path: "a/b" });
    expect(matchConfigPattern("/files.md", "/files/:path*.md")).toEqual({ path: "" });
    expect(matchConfigPattern("/files/.md", "/files/:path*.md")).toBeNull();
    expect(matchConfigPattern("/blog/.md", "/blog/:slug.md")).toBeNull();
  });

  it("splits a catch-all followed by an optional param like Next.js", () => {
    // The greedy repeat takes every segment; the optional param stays empty.
    expect(matchConfigPattern("/a/b/c", "/:path+/:tail?")).toEqual({ path: "a/b/c", tail: "" });
    expect(matchConfigPattern("/a", "/:path+/:tail?")).toEqual({ path: "a", tail: "" });
    expect(matchConfigPattern("/a/b", "/:path*/:tail?")).toEqual({ path: "a/b", tail: "" });
    expect(matchConfigPattern("/", "/:path*/:tail?")).toEqual({ path: "", tail: "" });
  });

  it("follows path-to-regexp's param name lexer", () => {
    // `-method` is literal text after the `auth` param.
    expect(matchConfigPattern("/auth-method", "/:auth-method")).toEqual({ auth: "auth" });
    expect(matchConfigPattern("/sign-method", "/:auth-method")).toEqual({ auth: "sign" });
    expect(matchConfigPattern("/auth", "/:auth-method")).toBeNull();
  });

  it("accepts the trailing slash Next.js accepts and no more", () => {
    expect(matchConfigPattern("/about/", "/about")).toEqual({});
    expect(matchConfigPattern("/about//", "/about")).toBeNull();
    expect(matchConfigPattern("/about", "/about/")).toBeNull();
    expect(matchConfigPattern("/about/", "/about/")).toEqual({});
    expect(matchConfigPattern("/docs/a/", "/docs/:rest(.*)")).toEqual({ rest: "a/" });
  });

  it("matches case-insensitively", () => {
    expect(matchConfigPattern("/CASE/PATH", "/Case/Path")).toEqual({});
    expect(matchConfigPattern("/x/EN", "/x/:locale(en|sv)?")).toEqual({ locale: "EN" });
  });

  it("matches headers sources with the same rules", () => {
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    const headers = [
      { source: "/api/:path*", headers: [{ key: "x-api", value: "1" }] },
      { source: "/static/:file(.*\\.js)", headers: [{ key: "x-js", value: "1" }] },
      { source: "/x/:locale?", headers: [{ key: "x-locale", value: "1" }] },
      // A glob is not a path-to-regexp source; Next.js fails the build.
      { source: "/glob/*", headers: [{ key: "x-glob", value: "1" }] },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(matchHeaders("/api", headers, ctx)).toEqual([{ key: "x-api", value: "1" }]);
      expect(matchHeaders("/api/a/b/", headers, ctx)).toEqual([{ key: "x-api", value: "1" }]);
      expect(matchHeaders("/apix", headers, ctx)).toEqual([]);
      expect(matchHeaders("/static/a/b.js", headers, ctx)).toEqual([{ key: "x-js", value: "1" }]);
      expect(matchHeaders("/static/a.css", headers, ctx)).toEqual([]);
      expect(matchHeaders("/x", headers, ctx)).toEqual([{ key: "x-locale", value: "1" }]);
      expect(matchHeaders("/glob/a", headers, ctx)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("substitutes captured params into rewrite and redirect destinations", () => {
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    expect(
      matchRewrite("/docs/a/b", [{ source: "/docs/:rest(.*)", destination: "/d/:rest" }], ctx),
    ).toBe("/d/a/b");
    expect(
      matchRedirect("/x", [{ source: "/x/:locale?", destination: "/y", permanent: false }], ctx)
        ?.destination,
    ).toBe("/y");
  });

  it("keeps a matched duplicate param when a later one is unmatched", () => {
    // Next.js's regexpToFunction skips unmatched captures.
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    expect({ ...matchConfigPattern("/x", "/:id?/:id?") }).toEqual({ id: "x" });
    expect(matchRewrite("/x", [{ source: "/:id?/:id?", destination: "/d" }], ctx)).toBe("/d?id=x");
    expect(matchRewrite("/x", [{ source: "/:id?/:id?", destination: "/d/:id" }], ctx)).toBe("/d/x");
  });

  it("appends only the source params that matched to the rewrite query", () => {
    // Expected values from Next.js prepareDestination with getPathMatch params.
    const ctx = requestContextFromRequest(new Request("http://localhost/"));
    const rewrite = (source: string, destination: string, pathname: string) =>
      matchRewrite(pathname, [{ source, destination }], ctx);
    expect(rewrite("/foo{-:bar}?", "/f", "/foo")).toBe("/f");
    expect(rewrite("/foo{-:bar}?", "/f", "/foo-x")).toBe("/f?bar=x");
    expect(rewrite("/x/:locale?", "/y", "/x")).toBe("/y");
    expect(rewrite("/x/:locale?", "/y", "/x/en")).toBe("/y?locale=en");
    // An empty capture is still a param.
    expect(rewrite("/docs/:rest(.*)", "/d", "/docs/")).toBe("/d?rest=");
  });
});

describe("matchRedirect destinations agree with Next.js", () => {
  const ctx = requestContextFromRequest(new Request("http://localhost/"));
  const { prepareDestination } =
    require("next/dist/shared/lib/router/utils/prepare-destination") as {
      prepareDestination: (args: object) => { parsedDestination: Record<string, unknown> };
    };
  const { formatUrl } = require("next/dist/shared/lib/router/utils/format-url") as {
    formatUrl: (url: object) => string;
  };

  it("formats credentials as Next.js formatUrl does", () => {
    for (const destination of [
      "https://u%20:p%20@example.com/a",
      "https://u:p@example.com/a",
      "https://:p@example.com/a",
      "https://u:@example.com/a",
      "https://u:p:q@example.com/a",
      "https://ü:ß@example.com/a",
    ]) {
      const { parsedDestination } = prepareDestination({
        appendParamsToQuery: false,
        destination,
        params: {},
        query: {},
      });
      const expected = formatUrl({ ...parsedDestination, query: undefined, search: "" });
      expect(
        matchRedirect("/r", [{ source: "/r", destination, permanent: false }], ctx)?.destination,
        destination,
      ).toBe(expected);
    }
  });

  it("collapses repeated slashes in the substituted pathname, after the basePath prefix", () => {
    const { normalizeRepeatedSlashes } = require("next/dist/shared/lib/utils") as {
      normalizeRepeatedSlashes: (url: string) => string;
    };
    for (const [destination, basePath] of [
      ["//target/x", "/docs"],
      ["//target/x", ""],
      ["/a//b\\c/:slug", ""],
      ["/:slug//z", "/docs"],
      ["https://example.com//a//:slug", "/docs"],
    ]) {
      // processRoutes prefixes the basePath on a local template.
      const template = destination.startsWith("/") ? basePath + destination : destination;
      const { parsedDestination } = prepareDestination({
        appendParamsToQuery: false,
        destination: template,
        params: { slug: "s" },
        query: {},
      });
      parsedDestination.pathname = normalizeRepeatedSlashes(parsedDestination.pathname as string);
      const expected = formatUrl({ ...parsedDestination, query: undefined, search: "" });
      expect(
        matchRedirect("/r/s", [{ source: "/r/:slug", destination, permanent: false }], ctx, {
          basePath,
          hadBasePath: true,
        })?.destination,
        `${basePath} ${destination}`,
      ).toBe(expected);
    }
  });

  it("leaves slashes captured into the host alone", () => {
    const { normalizeRepeatedSlashes } = require("next/dist/shared/lib/utils") as {
      normalizeRepeatedSlashes: (url: string) => string;
    };
    const destination = "https://:host.example/a//b";
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination,
      params: { host: "foo//bar" },
      query: {},
    });
    parsedDestination.pathname = normalizeRepeatedSlashes(parsedDestination.pathname as string);
    const expected = formatUrl({ ...parsedDestination, query: undefined, search: "" });
    expect(
      matchRedirect(
        "/r",
        [
          {
            source: "/r",
            destination,
            permanent: false,
            has: [{ type: "query", key: "host", value: "(?<host>.*)" }],
          },
        ],
        requestContextFromRequest(new Request("http://localhost/r?host=foo//bar")),
      )?.destination,
    ).toBe(expected);
  });

  it("consumes template backslash escapes in non-special pathnames and hashes", () => {
    const { normalizeRepeatedSlashes } = require("next/dist/shared/lib/utils") as {
      normalizeRepeatedSlashes: (url: string) => string;
    };
    for (const [destination, slug] of [
      ["myapp://example.com/a\\b", "s"],
      ["myapp://example.com/a\\\\b", "s"],
      ["mailto:a\\b", "s"],
      ["/a#x\\y", "s"],
      ["https://e.com/a#x\\y", "s"],
      ["/a#b\\:slug", "Q"],
      ["myapp://example.com/a\\:slug", "Q"],
      ["myapp://example.com/a\\\\:slug", "Q"],
      ["/a\\:slug", "Q"],
    ]) {
      const { parsedDestination } = prepareDestination({
        appendParamsToQuery: false,
        destination,
        params: { slug },
        query: {},
      });
      parsedDestination.pathname = normalizeRepeatedSlashes(parsedDestination.pathname as string);
      const expected = formatUrl({ ...parsedDestination, query: undefined, search: "" });
      expect(
        matchRedirect(
          `/r/${encodeURIComponent(slug)}`,
          [{ source: "/r/:slug", destination, permanent: false }],
          ctx,
        )?.destination,
        destination,
      ).toBe(expected);
    }
  });

  it("substitutes destinations Next.js throws on instead of failing the request", () => {
    // Next.js 16.2.7 throws on each of these; vinext substitutes the params.
    for (const [destination, pathname, expected] of [
      // The host parser lowercases a param name in the host.
      ["https://:tenantId.example.com/x", "/r/acme", "https://acme.example.com/x"],
      ["http://localhost::slug/x", "/r/3000", "http://localhost:3000/x"],
      [":slug://example.com/", "/r/https", "https://example.com/"],
      ["about", "/r/s", "about"],
    ]) {
      const source = destination.includes("tenantId") ? "/r/:tenantId" : "/r/:slug";
      expect(
        matchRedirect(pathname, [{ source, destination, permanent: false }], ctx)?.destination,
        destination,
      ).toBe(expected);
    }
  });

  it("keeps literal text and captures that look like escape markers", () => {
    // Next.js 16.2.7 throws on this destination; vinext redirects to it as written.
    expect(
      matchRedirect(
        "/r/s",
        [{ source: "/r/:slug", destination: "/__ESC_COLON_/:slug", permanent: false }],
        ctx,
      )?.destination,
    ).toBe("/__ESC_COLON_/s");
    // Next.js 16.2.7 inserts the capture verbatim.
    expect(
      matchRedirect(
        "/r/__ESC_LITERAL_COLON_",
        [{ source: "/r/:slug", destination: "/a/:slug", permanent: false }],
        ctx,
      )?.destination,
    ).toBe("/a/__ESC_LITERAL_COLON_");
  });
});

describe("matchRedirect locale-static index agrees with the compiled source", () => {
  const ctx = requestContextFromRequest(new Request("http://localhost/"));

  it("leaves sources with params after the locale segment to the linear scan", () => {
    const redirects = [
      { source: "/:locale(en|fr)?/admin/:path*", destination: "/login", permanent: false },
      // Shape emitted by applyLocaleToRoutes for an i18n `/docs/:slug` redirect.
      {
        source: "/:nextInternalLocale(en|fr)/docs/:slug",
        destination: "/:nextInternalLocale/guides/:slug",
        permanent: false,
      },
      { source: "/:locale(en|fr)?/blog/:id+", destination: "/posts/:id+", permanent: false },
    ];
    for (const pathname of [
      "/admin",
      "/admin/settings",
      "/en/admin/x",
      "/fr/admin",
      "/fr/admin/a/b",
    ]) {
      expect(matchRedirect(pathname, redirects, ctx)?.destination, pathname).toBe("/login");
    }
    expect(matchRedirect("/de/admin/settings", redirects, ctx)).toBeNull();
    expect(matchRedirect("/fr/docs/intro", redirects, ctx)?.destination).toBe("/fr/guides/intro");
    expect(matchRedirect("/fr/blog/a/b", redirects, ctx)?.destination).toBe("/posts/a/b");
    expect(matchRedirect("/fr/blog", redirects, ctx)).toBeNull();
  });

  it("does not resolve a locale-static rule an earlier linear rule shadows", () => {
    // Resolving parses the destination, which throws on an invalid URL; the
    // first rule wins in Next.js, so the second destination is never parsed.
    const redirects = [
      { source: "/:path*", destination: "/ok", permanent: false },
      {
        source: "/:locale(en|fr)?/foo",
        destination: "https://example.com:99999/a",
        permanent: false,
      },
    ];
    expect(matchRedirect("/en/foo", redirects, ctx)?.destination).toBe("/ok");
    expect(matchRedirect("/foo", redirects, ctx)?.destination).toBe("/ok");
  });

  it("leaves slash-ending sources to the linear scan", () => {
    const redirects = [
      { source: "/:locale(en|fr)?/about/", destination: "/team/", permanent: false },
      // Shape emitted by applyLocaleToRoutes for an i18n `/docs/` redirect.
      {
        source: "/:nextInternalLocale(en|fr)/docs/",
        destination: "/:nextInternalLocale/guides/",
        permanent: false,
      },
    ];
    expect(matchRedirect("/about/", redirects, ctx)?.destination).toBe("/team/");
    expect(matchRedirect("/fr/about/", redirects, ctx)?.destination).toBe("/team/");
    expect(matchRedirect("/fr/about", redirects, ctx)).toBeNull();
    expect(matchRedirect("/fr/docs/", redirects, ctx)?.destination).toBe("/fr/guides/");
  });

  it("leaves hyphenated param names and pattern alternatives to the linear scan", () => {
    const redirects = [
      // path-to-regexp reads `:my` followed by the literal `-locale`, so the
      // `(en|fr)` group is an unnamed param of its own.
      { source: "/:my-locale(en|fr)/about", destination: "/a", permanent: false },
      // `.*` can span more than the first segment.
      { source: "/:prefix(.*)/contact", destination: "/c", permanent: false },
    ];
    expect(matchRedirect("/x-localeen/about", redirects, ctx)?.destination).toBe("/a");
    expect(matchRedirect("/en/about", redirects, ctx)).toBeNull();
    expect(matchRedirect("/a/b/contact", redirects, ctx)?.destination).toBe("/c");
    expect(matchRedirect("/contact", redirects, ctx)).toBeNull();
  });

  it("matches indexed sources exactly like the compiled source", () => {
    const sources = [
      "/:locale(en|fr)?/about",
      "/:nextInternalLocale(en|fr)/about",
      "/:locale(en-US|fr)?/a/b",
      "/:locale(en|fr)?/a.b~c",
      "/:locale(en|fr)?/kelvin",
      "/:locale(en|fr)?/café",
    ];
    for (const source of sources) {
      const redirects = [{ source, destination: "/dest", permanent: false }];
      for (const pathname of [
        "/about",
        "/about/",
        "/about//",
        "/en/about",
        "/EN/about/",
        "/de/about",
        "/fr//about",
        "/en-us/a/b",
        "/a/b",
        "/fr/a.b~c",
        "/en/en/about",
        // A RegExp `i` match does not read the Kelvin sign as `k`, but does
        // fold `é` to `É`.
        "/kelvin",
        "/\u212Aelvin",
        "/en/\u212Aelvin",
        "/fr/KELVIN",
        "/CAFÉ",
        "/en/CAFÉ",
      ]) {
        expect(matchRedirect(pathname, redirects, ctx) !== null, `${source} ← ${pathname}`).toBe(
          matchConfigPattern(pathname, source) !== null,
        );
      }
    }
  });
});

describe("next.config.js source validation", () => {
  it.each([
    ["redirects", { redirects: () => [{ source: "/:a:b", destination: "/", permanent: false }] }],
    ["rewrites", { rewrites: () => ({ beforeFiles: [{ source: "/x/(", destination: "/" }] }) }],
    ["headers", { headers: () => [{ source: "/:id(a{2,1})", headers: [] }] }],
  ])("fails config loading on an invalid %s source like Next.js", async (_label, config) => {
    await expect(resolveNextConfig(config as never)).rejects.toThrow(
      /Invalid next\.config\.js (redirect|rewrite|header) source/,
    );
  });

  it.each([
    ["a missing", undefined, "`source` is missing"],
    ["an empty", "", "`source` is missing"],
    ["a non-string", 42, "`source` is not a string"],
    ["a relative", "about", "`source` does not start with /"],
    ["an overlong", "/" + "a".repeat(5_000), "`source` exceeds max built length of 4096"],
  ])("fails config loading on %s source like Next.js", async (_label, source, reason) => {
    await expect(
      resolveNextConfig({ headers: () => [{ source, headers: [] }] } as never),
    ).rejects.toThrow(reason);
  });

  it("applies Next.js's built-length limit at the same boundary", () => {
    for (const shape of [
      (n: number) => "/" + "a".repeat(n),
      (n: number) => "/:a/" + "b".repeat(n),
      (n: number) => "/x" + "/:p".repeat(n),
      (n: number) => "/" + "a.".repeat(n),
    ]) {
      const nextTooLong = (n: number) => tryToParsePath(shape(n)).regexStr!.length > 4096;
      // Smallest n whose source Next.js rejects.
      let low = 1;
      let high = 8_192;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (nextTooLong(mid)) high = mid;
        else low = mid + 1;
      }
      for (const n of [low - 1, low]) {
        const source = shape(n);
        const tooLong = configSourceError(source)?.includes("max built length") === true;
        expect(tooLong, `${source.slice(0, 12)}… (${source.length})`).toBe(nextTooLong(n));
      }
    }
  });

  it("checks sources again after adding the i18n locale prefix", async () => {
    // Fits the limit as written; the `/:nextInternalLocale(en|fr)` prefix
    // takes it over, so Next.js rejects it in its second check.
    const source = "/" + "a".repeat(4_072);
    const nextLength = (value: string) => tryToParsePath(value).regexStr!.length;
    expect(nextLength(source)).toBeLessThanOrEqual(4096);
    expect(nextLength(`/:nextInternalLocale(en|fr)${source}`)).toBeGreaterThan(4096);
    const headers = () => [{ source, headers: [] }];
    await expect(resolveNextConfig({ headers } as never)).resolves.toBeDefined();
    await expect(
      resolveNextConfig({ headers, i18n: { locales: ["en", "fr"], defaultLocale: "en" } } as never),
    ).rejects.toThrow("`source` exceeds max built length of 4096");
  });

  it("rejects malformed has/missing conditions like Next.js", async () => {
    // checkCustomRoutes in Next.js's load-custom-routes.ts fails the build
    // for each of these.
    const malformed = [
      {},
      "x",
      [null],
      [{ key: "x" }],
      [{ type: "unknown", key: "x" }],
      [{ type: "header" }],
      [{ type: "header", key: "x", value: 1 }],
      [{ type: "query", key: "q", value: ["a"] }],
      [{ type: "cookie", key: "c", value: Symbol("value") }],
      [{ type: "host" }],
    ];
    for (const has of malformed) {
      for (const field of ["has", "missing"]) {
        await expect(
          resolveNextConfig({
            redirects: () => [{ source: "/x", destination: "/y", permanent: false, [field]: has }],
          } as never),
          `${field} ${String(JSON.stringify(has))}`,
        ).rejects.toThrow(
          `Invalid next.config.js redirect has/missing condition:\n  "/x": \`${field}\``,
        );
      }
    }
    await expect(
      resolveNextConfig({
        rewrites: () => ({ fallback: [{ source: "/x", destination: "/y", has: [null] }] }),
      } as never),
    ).rejects.toThrow("Invalid next.config.js rewrite has/missing condition");
    await expect(
      resolveNextConfig({ headers: () => [{ source: "/x", headers: [], missing: {} }] } as never),
    ).rejects.toThrow("Invalid next.config.js header has/missing condition");

    // Next.js allows a host key, extra fields, and an omitted value for the
    // other types.
    await expect(
      resolveNextConfig({
        headers: () => [
          {
            source: "/x",
            headers: [],
            has: [
              { type: "host", key: "ignored", value: "example.com" },
              { type: "header", key: "x", extra: true },
            ],
            missing: [],
          },
        ],
      } as never),
    ).resolves.toBeDefined();
  });

  it("rejects a redirect without a valid status like Next.js", async () => {
    // checkRedirect in Next.js's load-custom-routes.ts fails the build for each
    // of these.
    for (const status of [
      { statusCode: 404 },
      { statusCode: 600 },
      { statusCode: 404, permanent: true },
      {},
      { permanent: "true" },
    ]) {
      await expect(
        resolveNextConfig({
          redirects: () => [{ source: "/x", destination: "/y", ...status }],
        } as never),
        JSON.stringify(status),
      ).rejects.toThrow('Invalid next.config.js redirect:\n  "/x": `');
    }

    // `statusCode` stands in for `permanent`, and takes precedence over it.
    const { redirects } = await resolveNextConfig({
      redirects: () => [
        { source: "/a", destination: "/y", statusCode: 301 },
        { source: "/b", destination: "/y", statusCode: 302, permanent: true },
      ],
    } as never);
    const statusOf = (pathname: string) =>
      matchRedirect(pathname, redirects, requestContextFromRequest(new Request("http://x/")))
        ?.statusCode;
    expect([statusOf("/a"), statusOf("/b")]).toEqual([301, 302]);
  });

  it("reports a missing route entry instead of crashing on it", async () => {
    for (const type of ["redirect", "rewrite", "header"]) {
      await expect(
        resolveNextConfig({ [`${type}s`]: () => [null] } as never),
        type,
      ).rejects.toThrow(`Invalid next.config.js ${type} source`);
    }
    await expect(
      resolveNextConfig({ rewrites: () => ({ beforeFiles: [null] }) } as never),
    ).rejects.toThrow("Invalid next.config.js rewrite source");
    // Sources that are not strings, some of which JSON cannot serialize.
    const unserializable = {
      toJSON: () => {
        throw new Error("toJSON");
      },
    };
    for (const source of [1n, Symbol("source"), Object.create(null), unserializable]) {
      await expect(
        resolveNextConfig({ headers: () => [{ source, headers: [] }] } as never),
      ).rejects.toThrow("Invalid next.config.js header source");
    }
  });

  it("checks sources again after adding basePath, like Next.js", async () => {
    // Next.js exits the build on an invalid route; vinext throws instead.
    const nextRejects = async (config: object): Promise<boolean> => {
      const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await loadCustomRoutes({ basePath: "", trailingSlash: false, ...config });
        return false;
      } catch (error) {
        if (String(error).includes("process.exit(1)")) return true;
        throw error;
      } finally {
        exit.mockRestore();
        vi.restoreAllMocks();
      }
    };
    const vinextRejects = async (config: object): Promise<boolean> =>
      resolveNextConfig(config as never).then(
        () => false,
        (error) => {
          expect(String(error)).toContain("Invalid next.config.js");
          return true;
        },
      );

    // Fits the limit as written, but not once `/base` is added.
    const long = "/" + "a".repeat(4_079);
    const header = (route: object) => ({
      headers: () => [{ headers: [{ key: "x", value: "1" }], ...route }],
    });
    // `en-US` is escaped to `en\-US` in the locale param, one more character.
    const localeBoundary = (() => {
      let n = 4_000;
      while (
        tryToParsePath(`/:nextInternalLocale(en\\-US|fr)/${"a".repeat(n)}`).regexStr!.length <= 4096
      )
        n++;
      return n;
    })();
    const i18n = { locales: ["en-US", "fr"], defaultLocale: "en-US" };
    const cases: Array<[string, object, boolean]> = [
      ["no basePath", header({ source: long }), false],
      ["basePath", { basePath: "/base", ...header({ source: long }) }, true],
      [
        "basePath: false",
        { basePath: "/base", ...header({ source: long, basePath: false }) },
        false,
      ],
      ["root with basePath", { basePath: "/base", ...header({ source: "/" }) }, false],
      [
        "redirect with basePath",
        {
          basePath: "/base",
          redirects: () => [{ source: long, destination: "/x", permanent: false }],
        },
        true,
      ],
      [
        "escaped locale over",
        { i18n, ...header({ source: `/${"a".repeat(localeBoundary)}` }) },
        true,
      ],
      [
        "escaped locale under",
        { i18n, ...header({ source: `/${"a".repeat(localeBoundary - 1)}` }) },
        false,
      ],
      [
        "locale and basePath",
        { i18n, basePath: "/b", ...header({ source: `/${"a".repeat(localeBoundary - 2)}` }) },
        true,
      ],
      [
        "locale: false",
        { i18n, ...header({ source: `/${"a".repeat(localeBoundary)}`, locale: false }) },
        false,
      ],
    ];
    for (const [name, config, rejected] of cases) {
      expect(await nextRejects(config), `Next.js: ${name}`).toBe(rejected);
      expect(await vinextRejects(config), `vinext: ${name}`).toBe(rejected);
    }
  });

  it("accepts valid sources", async () => {
    const config = await resolveNextConfig({
      redirects: () => [{ source: "/old/:path*", destination: "/new/:path*", permanent: true }],
      headers: () => [{ source: "/:locale(en|sv)?/about", headers: [] }],
    } as never);
    expect(config.redirects).toHaveLength(1);
    expect(config.headers).toHaveLength(1);
  });
});
