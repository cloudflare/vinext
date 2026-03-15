import { describe, expect, it } from "vite-plus/test";
import {
  createValidFileMatcher,
  normalizePageExtensions,
} from "../packages/vinext/src/routing/file-matcher.js";

describe("file matcher", () => {
  it("normalizes pageExtensions with defaults and preserves configured values", () => {
    expect(normalizePageExtensions()).toEqual(["tsx", "ts", "jsx", "js"]);
    expect(normalizePageExtensions([])).toEqual(["tsx", "ts", "jsx", "js"]);
    expect(normalizePageExtensions([".tsx", " ts ", "tsx", "", ".mdx"])).toEqual([
      "tsx",
      "ts",
      "tsx",
      "mdx",
    ]);
  });

  it("matches app router page and route files by configured extensions", () => {
    // Ported from Next.js matcher tests:
    // test/unit/find-page-file.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/unit/find-page-file.test.ts
    const matcher = createValidFileMatcher(["tsx", "ts", "jsx", "js", "mdx"]);

    expect(matcher.isAppRouterPage("page.js")).toBe(true);
    expect(matcher.isAppRouterPage("./page.mdx")).toBe(true);
    expect(matcher.isAppRouterPage("/path/page.tsx")).toBe(true);
    expect(matcher.isAppRouterPage("/path/route.ts")).toBe(true);

    expect(matcher.isAppRouterRoute("/path/route.ts")).toBe(true);
    expect(matcher.isAppRouterRoute("/path/page.tsx")).toBe(false);

    expect(matcher.isAppLayoutFile("/path/layout.tsx")).toBe(true);
    expect(matcher.isAppDefaultFile("/path/default.mdx")).toBe(true);
    expect(matcher.isAppRouterPage("/path/layout.tsx")).toBe(false);
  });

  it("strips configured extensions from file paths", () => {
    const matcher = createValidFileMatcher(["js", "jsx", "mdx", "m+d"]);
    expect(matcher.stripExtension("about.mdx")).toBe("about");
    expect(matcher.stripExtension("index.m+d")).toBe("index");
    expect(matcher.stripExtension("about.tsx")).toBe("about.tsx");
  });
});
