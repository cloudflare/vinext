/**
 * `images.localPatterns` matching unit tests, mirroring Next.js's
 * matchLocalPattern / hasLocalMatch semantics.
 */
import { createRequire } from "node:module";
import { describe, it, expect } from "vite-plus/test";
import {
  hasLocalMatch,
  matchLocalPattern,
} from "../packages/vinext/src/server/image-local-patterns.js";

describe("matchLocalPattern", () => {
  const local = (pathAndQuery: string) => new URL(pathAndQuery, "http://n");

  it("matches pathname globs", () => {
    expect(matchLocalPattern({ pathname: "/photos/**" }, local("/photos/a/b.png"))).toBe(true);
    expect(matchLocalPattern({ pathname: "/photos/*" }, local("/photos/a.png"))).toBe(true);
    expect(matchLocalPattern({ pathname: "/photos/*" }, local("/photos/a/b.png"))).toBe(false);
    expect(matchLocalPattern({ pathname: "/photos/**" }, local("/downloads/a.png"))).toBe(false);
  });

  it("defaults pathname to ** and leaves search unchecked when unset", () => {
    expect(matchLocalPattern({}, local("/any/path.png?v=2"))).toBe(true);
  });

  it("compares search exactly when set", () => {
    expect(matchLocalPattern({ search: "" }, local("/a.png"))).toBe(true);
    expect(matchLocalPattern({ search: "" }, local("/a.png?"))).toBe(true);
    expect(matchLocalPattern({ search: "" }, local("/a.png?v=2"))).toBe(false);
    expect(matchLocalPattern({ search: "?v=2" }, local("/a.png?v=2"))).toBe(true);
    expect(matchLocalPattern({ search: "?v=2" }, local("/a.png?v=3"))).toBe(false);
  });
});

// Next.js compiles local pathnames with picomatch (`makeRe(pathname, { dot:
// true })`). Each case is checked against Next.js's compiled picomatch.
describe("matchLocalPattern pathname parity with Next.js picomatch", () => {
  it("agrees on typical * and ** patterns", () => {
    const picomatch = createRequire(import.meta.url)("next/dist/compiled/picomatch") as {
      makeRe(pattern: string, options: { dot: boolean }): RegExp;
    };
    const cases: Array<[string, string, boolean]> = [
      ["**", "/a/b.png", true],
      ["/**", "/a.png", true],
      ["/photos/**", "/photos", true],
      ["/photos/**", "/photos/a/b.png", true],
      ["/photos/**", "/photosx/a.png", false],
      ["/photos/**/hero.png", "/photos/hero.png", true],
      ["/photos/**/hero.png", "/photos/a/b/hero.png", true],
      ["/photos/**/hero.png", "/photos/xhero.png", false],
      ["**/hero.png", "/a/hero.png", true],
      ["/photos/*", "/photos/a.png", true],
      ["/photos/*", "/photos/", false],
      ["/photos/*", "/photos/a/b.png", false],
      ["/photos/*", "/photos/team/", true],
      ["/photos/*", "/photos//", true],
      ["/photos/*", "/photos///", false],
      ["/photos/a*", "/photos/ab/", true],
      ["/photos/*.png", "/photos/a.png/", false],
      ["/photos/team", "/photos/team/", false],
      ["/foo/*.png", "/foo/.png", true],
      ["/foo/*.png", "/foo/a.png", true],
      ["/foo/*.png", "/foo/a/b.png", false],
      ["/photos/**.png", "/photos/a.png", true],
      ["/photos/**.png", "/photos/a/b.png", false],
      ["/a/x*y/b", "/a/xzy/b", true],
      ["/_next/static/media/**", "/_next/static/media/hero.0a1b2c3d.png", true],
      ["/**", "/", true],
      ["/**/private.png", "/private.png", false],
      ["/**/private.png", "/a/private.png", true],
      ["/*/**", "/public.png", false],
      ["/*/**", "/a/", true],
      ["/a*/**", "/ab", false],
      ["/x*y/**", "/xzy", true],
      ["/*.png/**", "/x.png", true],
      ["/a/*/**", "/a/b", false],
      ["/*/**/c", "/a/c", true],
      ["/a*/**/c", "/ab/c", true],
      ["/a/**/*", "/a/b", true],
      ["/**/*", "/a", false],
      ["/**/**", "/a", true],
      ["/a/**/**", "/a", true],
      ["/a/**/**/b", "/a/b", true],
    ];
    for (const [pattern, pathname, expected] of cases) {
      const url = new URL(pathname, "http://n");
      expect(picomatch.makeRe(pattern, { dot: true }).test(url.pathname), "Next.js").toBe(expected);
      expect(matchLocalPattern({ pathname: pattern }, url), `${pattern} ${pathname}`).toBe(
        expected,
      );
    }
  });
});

describe("hasLocalMatch", () => {
  it("allows every local URL when no list is set", () => {
    expect(hasLocalMatch(undefined, new URL("http://n/a.png?v=2"))).toBe(true);
  });

  it("requires a match in a configured list", () => {
    const patterns = [{ pathname: "/photos/**", search: "" }];
    expect(hasLocalMatch(patterns, new URL("http://n/photos/team.png"))).toBe(true);
    expect(hasLocalMatch(patterns, new URL("http://n/downloads/poster.png"))).toBe(false);
    expect(hasLocalMatch([], new URL("http://n/photos/team.png"))).toBe(false);
  });
});
