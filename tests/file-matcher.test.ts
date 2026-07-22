import { describe, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createValidFileMatcher,
  normalizePageExtensions,
  scanWithExtensions,
} from "../packages/vinext/src/routing/file-matcher.js";
import { shouldInvalidateAppRouteFile } from "../packages/vinext/src/server/dev-route-files.js";

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

  it("scans route files inside dot-directories", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-dot-route-scan-"));
    try {
      await mkdir(path.join(tmpDir, "api"), { recursive: true });
      await mkdir(path.join(tmpDir, ".well-known", "openid-configuration"), {
        recursive: true,
      });
      await writeFile(path.join(tmpDir, "route.ts"), "");
      await writeFile(path.join(tmpDir, "api", "route.ts"), "");
      await writeFile(path.join(tmpDir, ".well-known", "openid-configuration", "route.ts"), "");

      const files = [];
      for await (const file of scanWithExtensions("**/route", tmpDir, ["ts"])) {
        files.push(file);
      }

      expect(files.sort()).toEqual([
        ".well-known/openid-configuration/route.ts",
        "api/route.ts",
        "route.ts",
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies only app route structure files as dev route invalidations", () => {
    // Mirrors Next.js dev route discovery:
    // packages/next/src/server/lib/find-page-file.ts
    // packages/next/src/server/lib/router-utils/setup-dev-bundler.ts
    const matcher = createValidFileMatcher(["tsx", "ts", "jsx", "js", "mdx"]);
    const appDir = "/project/app";

    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/page.tsx", matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/route.ts", matcher)).toBe(true);
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/layout.tsx", matcher)).toBe(
      true,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/loading.jsx", matcher)).toBe(
      true,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/not-found.mdx", matcher)).toBe(
      true,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/@modal/default.tsx", matcher)).toBe(
      true,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/robots.ts", matcher)).toBe(true);
    expect(
      shouldInvalidateAppRouteFile(appDir, "/project/app/blog/opengraph-image.png", matcher),
    ).toBe(true);

    expect(
      shouldInvalidateAppRouteFile(appDir, "/project/app/components/Button.tsx", matcher),
    ).toBe(false);
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/page.css", matcher)).toBe(false);
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/_private/page.tsx", matcher)).toBe(
      false,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app-utils/page.tsx", matcher)).toBe(
      false,
    );
    expect(shouldInvalidateAppRouteFile(appDir, "/project/app/blog/robots.ts", matcher)).toBe(
      false,
    );
  });
});
