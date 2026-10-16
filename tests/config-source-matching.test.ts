import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configSourceError,
  matchConfigPattern,
  matchHeaders,
  matchRedirect,
  matchRewrite,
  requestContextFromRequest,
} from "../packages/vinext/src/config/config-matchers.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import {
  clientConfigSourceCouldMatch,
  clientRewriteAppendsParams,
  matchSimpleClientConfigSource,
} from "../packages/vinext/src/client/client-config-source-match.js";

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
});

describe("Pages client sync matcher agrees with the server matcher", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CLIENT_PATHNAMES = [
    ...PATHNAMES,
    "/About/",
    "/\u212Aey",
    "/DOCS/A/B",
    "/x/en/",
    "/foobar",
    "/foo.x.y",
    "/foo/x/",
    "/FOO.x",
    "/foo",
    "/foo//",
    "/foo/bar",
    "/foo.json",
  ];
  const CLIENT_SOURCES = [
    ...SOURCES,
    "/key",
    "/docs/:path*/",
    "/:a/b/:c",
    "/Docs/:path+",
    "/foo.:ext?",
    "/foo.:ext*",
    "/foo/:id?",
    "/foo/:id+",
    "/foo/:id?bar",
    "/foo.:ext(x)?",
    "/:id?",
    "/foo/",
    "/foo/:id(\\d+)",
    "/foo/:id(\\d+)?",
    "/foo/:id(x|(y))*",
    "/foo/:id([)]+)",
    "/foo/:id(\\d+)?/bar",
    "/foo/:id?/bar",
    "/foo.:ext*.json",
    "/foo/:id?/:slug?",
    "/foo/:id(b)?ar",
  ];

  it("returns the server's params whenever it does not defer", () => {
    for (const source of CLIENT_SOURCES) {
      for (const pathname of CLIENT_PATHNAMES) {
        const actual = matchSimpleClientConfigSource(pathname, source);
        if (actual === undefined) continue;
        expect(actual, `${source} ← ${pathname}`).toEqual(matchConfigPattern(pathname, source));
      }
    }
  });

  it("only rules out sources the server cannot match", () => {
    for (const source of CLIENT_SOURCES) {
      for (const pathname of CLIENT_PATHNAMES) {
        if (clientConfigSourceCouldMatch(pathname, source)) continue;
        expect(matchConfigPattern(pathname, source), `${source} ← ${pathname}`).toBeNull();
      }
    }
  });

  it("rules out a source whose optional param prefix the pathname lacks", () => {
    // An optional param's prefix may be absent, but then whatever follows
    // the param must be there, so `/foobar` cannot reach `/foo.:ext?`,
    // `/foo/:id?` or `/foo/:id?/bar`.
    for (const source of [
      "/foo.:ext?",
      "/foo/:id?",
      "/foo/:id+",
      "/foo.:ext",
      "/foo/",
      "/foo/:id(\\d+)",
      "/foo/:id(\\d+)?",
      "/foo/:id(x|(y))*",
      "/foo/:id([)]+)",
      "/foo/:id(\\d+)?/bar",
      "/foo/:id?/bar",
      "/foo.:ext*.json",
    ]) {
      expect(clientConfigSourceCouldMatch("/foobar", source), source).toBe(false);
    }
    for (const [source, pathname] of [
      ["/foo.:ext?", "/foo"],
      ["/foo.:ext?", "/foo/"],
      ["/foo.:ext?", "/FOO.x"],
      ["/foo/:id?bar", "/foobar"],
      ["/foo/:id(\\d+)?", "/foo"],
      ["/foo/:id(\\d+)", "/foo/1"],
      ["/foo/:id(b)?ar", "/fooar"],
      ["/foo/:id?/bar", "/foo/bar"],
      ["/foo.:ext*.json", "/foo.json"],
      // The `/` before `:slug?` is that param's own optional prefix.
      ["/foo/:id?/:slug?", "/foo"],
    ] as const) {
      expect(clientConfigSourceCouldMatch(pathname, source), source).toBe(true);
    }
  });

  it("defers sources it does not model", () => {
    for (const [source, pathname] of [
      ["/x/:locale?", "/x/en"],
      ["/:auth-method", "/google-method"],
      ["/blog-:slug", "/blog-x"],
      ["/blog/:slug.md", "/blog/x.md"],
      ["/foo{-:bar}?", "/foo-x"],
      ["/docs/:rest(.*)", "/docs/a"],
      ["/a\\:b", "/a:b"],
      ["/docs/:path*/", "/docs/a/"],
      ["/\u20ac/:slug", "/\u20ac/x"],
      ["/docs/:path*", "/docs//a"],
      // Duplicate names keep the last capture that matched.
      ["/:id/:id*", "/foo"],
      // An empty `*` is unmatched, which can change the rewrite query.
      ["/From/:id/:rest*", "/from/foo"],
      ["/docs/:path*", "/docs"],
      ["/:id/:id", "/a/b"],
    ]) {
      expect(matchSimpleClientConfigSource(pathname, source), source).toBeUndefined();
    }
  });

  it("returns a null-prototype params object", () => {
    for (const params of [
      matchSimpleClientConfigSource("/foo/x", "/foo/:__proto__"),
      matchConfigPattern("/foo/x", "/foo/:__proto__"),
    ]) {
      expect(Object.getPrototypeOf(params)).toBeNull();
      expect(Object.hasOwn(params!, "__proto__")).toBe(true);
      expect(params!["__proto__"]).toBe("x");
    }
  });

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
      const params = matchSimpleClientConfigSource(pathname, source)!;
      expect(clientRewriteAppendsParams(destination, params), source).toBe(defers);
    }
    // An empty `*` is unmatched, so the server appends `id`; the fast path
    // defers it rather than substitute `/target/`.
    expect(
      matchRewrite(
        "/from/foo",
        [{ source: "/From/:id/:rest*", destination: "/target/:rest*" }],
        ctx,
      ),
    ).toBe("/target/?id=foo");
    expect(matchSimpleClientConfigSource("/from/foo", "/From/:id/:rest*")).toBeUndefined();
  });

  it("matches the shapes it models", () => {
    expect(matchSimpleClientConfigSource("/About/", "/about")).toEqual({});
    expect(matchSimpleClientConfigSource("/\u212Aey", "/key")).toBeNull();
    expect(matchSimpleClientConfigSource("/docs/a/b/", "/docs/:path*")).toEqual({ path: "a/b" });
    expect(matchSimpleClientConfigSource("/docs", "/docs/:path+")).toBeNull();
    expect(matchSimpleClientConfigSource("/blog/x", "/blog/:slug")).toEqual({ slug: "x" });
    // path-to-regexp reads `[`, `]`, `|` and `)` as plain text.
    expect(matchSimpleClientConfigSource("/FOO[BAR]", "/foo[bar]")).toEqual({});
    expect(matchSimpleClientConfigSource("/a|b", "/a|b")).toEqual({});
    expect(matchSimpleClientConfigSource("/FOO)BAR", "/foo)bar")).toEqual({});
  });
});

describe("config source matching regressions", () => {
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

  it("reports a source the ReDoS check skips when the config loads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Built from parts so static ReDoS scanners do not flag the fixture.
    const repeated = "(?:a+)";
    const source = `/redos-at-load/:id(${repeated}+b)`;
    try {
      // Next.js accepts the source, so it is not a load error.
      await expect(
        resolveNextConfig({ headers: () => [{ source, headers: [] }] } as never),
      ).resolves.toBeDefined();
      const skipped = () =>
        warn.mock.calls.filter(([message]) => String(message).includes(`"${source}" (ReDoS risk)`));
      expect(skipped()).toHaveLength(1);
      expect(matchConfigPattern("/redos-at-load/aab", source)).toBeNull();
      expect(skipped()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a missing route entry instead of crashing on it", async () => {
    await expect(resolveNextConfig({ headers: () => [null] } as never)).rejects.toThrow(
      "Invalid next.config.js header source",
    );
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

  it("leaves ReDoS-unsafe sources to warn and skip when matched", async () => {
    // Next.js accepts these, and the ReDoS check is conservative: it also
    // flags linear shapes such as this slug pattern.
    const source = "/blog/:slug([a-z0-9]+(?:-[a-z0-9]+)*)";
    const config = await resolveNextConfig({
      headers: () => [{ source, headers: [{ key: "x", value: "1" }] }],
    } as never);
    expect(config.headers).toHaveLength(1);
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

describe("config sources do not backtrack catastrophically", () => {
  // Sources whose compiled regexes are linear: a 16 KB near-miss pathname
  // takes well under a millisecond per match. The bound catches exponential
  // and cubic blowups, which take seconds or never finish at this size.
  const LINEAR_SOURCES = [
    "/:path*",
    "/:path+/:tail?",
    "/:path*/:tail?",
    "/:a/:b?",
    "/:a-:b",
    "/:a.:b",
    "/blog-:slug",
    "/files/:path*.md",
    "/files/:path+.md",
    "/:locale(en|sv)?/:path*",
    "/:locale/files/:path*",
    "/n/:id(\\d+)*",
    "/:year(\\d+)/:month(\\d+)",
    "/docs/:rest(.*)",
    "/:a(.*)/:b",
    "/(.*)",
    "/foo{-:bar}+",
    "/files/:name{.:ext}?",
    "/x{.:ext}*",
    "/{-:a([a-z]+)-}+",
    "/:lang(en|fr)*",
    "/{ab:id(a+)cd}+",
    // Fixed-width repeats split by length alone.
    "/{a:id(a)}+",
    "/{a:id([a-z]{2})}*",
    "/{a:id(\\/)}+",
    "/:a(a+):b(a+)",
    "/:a(\\d+)/:b(\\d+)/:c(\\d+)",
    "/:a?/:b?/:c?/:d?",
    "/:a-:b-:c-:d",
    // Each repeat starts after a "/" that its pattern cannot consume.
    "/:a([^/]*)+/end",
    // The delimiter decides between alternatives that share a prefix.
    "/:lang(en|en-US)+",
    // A "/" inside the pattern, but never at either end of a match.
    "/:id([a-z]+\\/[a-z]+)+",
    // One empty match per segment.
    "/:id(a?)+/end",
    "/:id(a|)+/end",
    "/:id((?:)|a)+/end",
    // The `(?!ab)` guard path-to-regexp adds keeps each repeat out of "ab".
    "/{ab:id}+",
    "/x{--:id}+",
    // Unrolled exactly while it fits: as `a+` the repeat would overlap the
    // repeated token's "a" prefix.
    "/{a:id(a{1025})}+X",
    "/{a:id(a{8000})}+X",
    // Long bounded repeats are read as unbounded rather than unrolled.
    "/:id(a{16385})",
    "/:id([a-z]{2,20000})",
    "/{x:id(a{3000})}+",
    // An empty lookahead never matches.
    "/:id((?!(?:))a)",
    // `(?!a)` rules out the first copy of `a+`, so only `b+` can match.
    "/{a:id((?:(?!a)a+|b+))}+",
  ];
  const ADVERSARIAL_PATHNAMES = [
    "/" + "a/".repeat(8_000) + "!",
    "/" + "a".repeat(16_000) + "/",
    "/" + "-".repeat(16_000) + "/x",
    "/" + ".".repeat(16_000) + "/x",
    "/" + "a-".repeat(8_000) + "/",
    "/" + "-a-".repeat(5_000) + "/",
    "/x" + ".a".repeat(8_000) + "/",
    "/" + "en/".repeat(5_000) + "x",
    "/" + "a".repeat(16_001) + "/",
    "/" + "a/".repeat(8_000),
    "/" + "1/".repeat(5_000) + "x",
    "/" + "a.".repeat(8_000) + "/",
    "/foo" + "-a".repeat(8_000) + "/",
    "/files/" + "a/".repeat(8_000) + "x.mdx",
    "/n/" + "1/".repeat(8_000) + "x",
    "/" + "1".repeat(16_000) + "/x/y",
    "//" + "/".repeat(16_000),
    "/" + "en-US/".repeat(3_000) + "!",
    "/" + "a/b/".repeat(4_000) + "!",
    "/" + "ab".repeat(8_000) + "!",
    "/x" + "--a".repeat(5_000) + "-!",
  ];

  it("accepts sources whose compiled regexes are linear", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const source of LINEAR_SOURCES) {
        // A distinct pathname per source keeps the compile cache honest.
        matchConfigPattern(`/linear-probe${source}`, source);
        expect(warn, source).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("matches near-miss pathnames without catastrophic backtracking", () => {
    for (const source of LINEAR_SOURCES) {
      for (const pathname of ADVERSARIAL_PATHNAMES) {
        const start = performance.now();
        matchConfigPattern(pathname, source);
        const elapsed = performance.now() - start;
        expect(elapsed, `${source} ← ${pathname.slice(0, 24)}… (${pathname.length})`).toBeLessThan(
          250,
        );
      }
    }
  });

  it("rejects custom param patterns that backtrack catastrophically", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const source of [
        "/:a((?:a+)+)",
        "/:a((?:a|a)*)b",
        "/:a((?:a*)*)",
        "/:a(\\d*\\d*)x",
        "/:a(a*a*)b",
        // A repeated param that can match "/" has many partitions.
        "/:a(.*)*/end",
        "/:a(.+)+/end",
        // A repeated param that can match part of its own separator.
        "/{a:id(a+)}*X",
        "/{a:id(a+)}+X",
        "/x{-:id([a-z-]+)}+",
        // The RegExp has no `u` flag, so `[😀]` takes either surrogate.
        "/{\u{1F600}:id([\u{1F600}]+)}+X",
        // `(?!\/)` only rules out "/" as the first character of the group.
        "/:p((?!\\/)(?i:[a-z/]+))+",
        // Alternatives that match the same text multiply per segment.
        "/:id(a|aa?)+",
        "/{x:id(a|a)}+",
        // So do adjacent optionals: each "ab" segment has two parses.
        "/:id(a?a?b)+",
        // And two empty matches: each "/" segment has two parses.
        "/:id(|)+/end",
        "/:id(a?|b?)+/end",
        // Overlapping repeats inside a scoped flag group or an octal escape.
        "/:id(a(?i:a+)(?i:a+)(?i:a+))",
        "/:id(\\141+\\141+\\141+)",
        "/:a((?i:a+)):b((?-i:a+)):c((?i:a+))",
        // `(?-i:(?!A))` lets "a" through, so both alternatives read it.
        "/:id((?:(?-i:(?!A)a+)|a+))+",
        // A guard that leaves both alternatives able to read "a".
        "/{ab:id((?:(?!ab)a|a))}+",
        // Adjacent params form one chain of overlapping repeats.
        "/:a(a+):b(a+):c(a+)",
        "/:a(.*):b(.*):c(.*)",
        "/:a(\\d+)(\\d+)(\\d+)",
      ]) {
        expect(matchConfigPattern("/" + "a".repeat(64) + "!", source), source).toBeNull();
        expect(warn, source).toHaveBeenLastCalledWith(
          expect.stringContaining(`Ignoring next.config.js source "${source}" (ReDoS risk)`),
        );
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
