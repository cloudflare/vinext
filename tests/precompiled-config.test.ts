/**
 * Serialization roundtrip tests for buildPrecompiledConfigCode.
 *
 * These tests verify that compiled regex patterns survive the full
 * RegExp.toString() → code-embed → eval cycle correctly. A pattern that
 * looks right in a snapshot can still silently break if regex flags are
 * dropped, forward slashes are mis-escaped, or special characters in param
 * names corrupt the serialized JSON.
 */
import { describe, it, expect } from "vitest";
import { buildPrecompiledConfigCode } from "../packages/vinext/src/config/precompiled-config.js";

type CompiledPattern = { re: RegExp; paramNames: string[] } | null;
type CompiledRewrites = {
  beforeFiles: CompiledPattern[];
  afterFiles: CompiledPattern[];
  fallback: CompiledPattern[];
};

/** Evaluate a serialized array/object expression and return the result. */
function evalCode<T>(code: string): T {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${code}`)() as T;
}

describe("buildPrecompiledConfigCode serialization roundtrip", () => {
  it("redirect patterns with inline regex groups survive roundtrip", () => {
    const config = {
      redirects: [
        // Inline regex group — usesRegexBranch → true, compiles to non-null
        { source: "/items/(\\d+)/detail", destination: "/item-detail", permanent: false },
        // Named param with alternation constraint
        { source: "/:lang(en|fr)/about", destination: "/about", permanent: true },
        // Simple static path — no regex branch, compiles to null
        { source: "/old-path", destination: "/new-path", permanent: true },
      ],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
    };

    const code = buildPrecompiledConfigCode(config);
    const compiled = evalCode<CompiledPattern[]>(code.redirects);

    // Pattern 0: inline \d+ group
    expect(compiled[0]).not.toBeNull();
    expect(compiled[0]!.re.test("/items/42/detail")).toBe(true);
    expect(compiled[0]!.re.test("/items/abc/detail")).toBe(false);
    expect(compiled[0]!.re.test("/items/42")).toBe(false);

    // Pattern 1: named param with alternation constraint — paramNames preserved
    expect(compiled[1]).not.toBeNull();
    expect(compiled[1]!.re.test("/en/about")).toBe(true);
    expect(compiled[1]!.re.test("/fr/about")).toBe(true);
    expect(compiled[1]!.re.test("/de/about")).toBe(false);
    expect(compiled[1]!.paramNames).toEqual(["lang"]);

    // Pattern 2: simple static path — no regex branch, must be null
    expect(compiled[2]).toBeNull();
  });

  it("rewrite patterns survive roundtrip", () => {
    const config = {
      redirects: [],
      rewrites: {
        beforeFiles: [
          // Param with dot suffix — usesRegexBranch via :[\w-]+\. check
          { source: "/:slug.html", destination: "/:slug" },
        ],
        afterFiles: [
          // Named param with constraint
          { source: "/:version(v1|v2)/api/:path*", destination: "/api/:path*" },
        ],
        fallback: [
          // Simple param — no regex branch, null
          { source: "/:page", destination: "/page/:page" },
        ],
      },
      headers: [],
    };

    const code = buildPrecompiledConfigCode(config);
    const compiled = evalCode<CompiledRewrites>(code.rewrites);

    // beforeFiles[0]: /:slug.html
    expect(compiled.beforeFiles[0]).not.toBeNull();
    expect(compiled.beforeFiles[0]!.re.test("/my-post.html")).toBe(true);
    expect(compiled.beforeFiles[0]!.re.test("/my-post.htm")).toBe(false);
    expect(compiled.beforeFiles[0]!.paramNames).toEqual(["slug"]);

    // afterFiles[0]: /:version(v1|v2)/api/:path*
    expect(compiled.afterFiles[0]).not.toBeNull();
    expect(compiled.afterFiles[0]!.re.test("/v1/api/users")).toBe(true);
    expect(compiled.afterFiles[0]!.re.test("/v2/api/posts/1")).toBe(true);
    expect(compiled.afterFiles[0]!.re.test("/v3/api/users")).toBe(false);

    // fallback[0]: /:page — simple param, null
    expect(compiled.fallback[0]).toBeNull();
  });

  it("header source patterns survive roundtrip", () => {
    const config = {
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [
        { source: "/api/(.*)", headers: [{ key: "X-Api", value: "1" }] },
        { source: "/static/path", headers: [{ key: "X-Static", value: "1" }] },
      ],
    };

    const code = buildPrecompiledConfigCode(config);
    const compiled = evalCode<Array<RegExp | null>>(code.headers);

    // Header 0: /api/(.*)
    expect(compiled[0]).not.toBeNull();
    expect(compiled[0]! instanceof RegExp).toBe(true);
    expect(compiled[0]!.test("/api/users")).toBe(true);
    expect(compiled[0]!.test("/api/nested/path")).toBe(true);
    expect(compiled[0]!.test("/other/path")).toBe(false);

    // Header 1: /static/path — static source also compiles to a regex
    expect(compiled[1]).not.toBeNull();
    expect(compiled[1]!.test("/static/path")).toBe(true);
    expect(compiled[1]!.test("/static/other")).toBe(false);
  });

  it("empty config produces empty arrays without throwing", () => {
    const code = buildPrecompiledConfigCode({
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
    });

    expect(() => evalCode(code.redirects)).not.toThrow();
    expect(() => evalCode(code.rewrites)).not.toThrow();
    expect(() => evalCode(code.headers)).not.toThrow();

    expect(evalCode<CompiledPattern[]>(code.redirects)).toEqual([]);
    expect(evalCode<CompiledRewrites>(code.rewrites)).toEqual({
      beforeFiles: [],
      afterFiles: [],
      fallback: [],
    });
    expect(evalCode<Array<RegExp | null>>(code.headers)).toEqual([]);
  });

  it("hyphenated param names are preserved through JSON.stringify serialization", () => {
    const config = {
      redirects: [
        // Hyphenated param name — valid in Next.js patterns
        { source: "/:auth-token(Bearer|Basic)", destination: "/auth", permanent: false },
      ],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
    };

    const code = buildPrecompiledConfigCode(config);
    const compiled = evalCode<CompiledPattern[]>(code.redirects);

    expect(compiled[0]).not.toBeNull();
    expect(compiled[0]!.paramNames).toEqual(["auth-token"]);
    expect(compiled[0]!.re.test("/Bearer")).toBe(true);
    expect(compiled[0]!.re.test("/Basic")).toBe(true);
    expect(compiled[0]!.re.test("/Digest")).toBe(false);
  });
});
