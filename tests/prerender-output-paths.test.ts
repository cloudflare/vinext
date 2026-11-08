/**
 * Output paths for prerendered HTML / Flight / App Route artifacts.
 *
 * Next.js `normalizePagePath` throws when `posix.normalize` changes the path,
 * which is what stops `..` params from writing an export outside the output
 * directory. Ported from:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/page-path/normalize-page-path.ts
 */
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  getAppRouteOutputPath,
  getOutputPath,
  getRscOutputPath,
} from "../packages/vinext/src/utils/prerender-output-paths.js";

describe("getOutputPath", () => {
  it("keeps ordinary pages inside the output directory", () => {
    expect(getOutputPath("/", false)).toBe("index.html");
    expect(getOutputPath("/about", false)).toBe("about.html");
    expect(getOutputPath("/about", true)).toBe("about/index.html");
    expect(getOutputPath("/blog/index", false)).toBe("blog/index.html");
    expect(getOutputPath("/", false, "/docs")).toBe("docs.html");
    expect(getOutputPath("/about", true, "/docs")).toBe("docs/about/index.html");
  });

  // cloudflare/vinext#4583: getStaticPaths { a: "..", b: "..", c: ".." } on
  // /x/[a]/[b]/[c] with trailingSlash becomes x/../../../index.html, and
  // path.join(dist/client, that) lands on the project root.
  it("throws when a Pages export URL would leave the output directory", () => {
    const escaping = "/x/../../..";
    const relative = "x/../../../index.html";
    expect(path.posix.normalize(relative)).not.toBe(relative);
    expect(() => getOutputPath(escaping, true)).toThrow(/mismatch/);
    expect(() => getOutputPath(escaping, false)).toThrow(/mismatch/);
    expect(() => getOutputPath("/blog/..", true)).toThrow(/mismatch/);
  });
});

describe("getRscOutputPath and getAppRouteOutputPath", () => {
  it("throws when a dot-segment URL would leave the output directory", () => {
    expect(() => getRscOutputPath("/x/../../..", { mode: "export", trailingSlash: true })).toThrow(
      /mismatch/,
    );
    expect(() => getRscOutputPath("/x/../../..")).toThrow(/mismatch/);
    expect(() => getAppRouteOutputPath("/x/../../..")).toThrow(/mismatch/);
  });
});
