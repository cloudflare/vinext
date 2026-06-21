import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  createValidFileMatcher,
  normalizePageExtensions,
  scanWithExtensions,
} from "../packages/vinext/src/routing/file-matcher.js";
import { shouldInvalidateAppRouteFile } from "../packages/vinext/src/server/dev-route-files.js";

async function collectScan(
  stem: string,
  cwd: string,
  extensions: readonly string[],
  exclude?: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  for await (const file of scanWithExtensions(stem, cwd, extensions, exclude)) {
    out.push(file.split(path.sep).join("/"));
  }
  return out.sort();
}

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

describe("scanWithExtensions directory traversal", () => {
  it("discovers route files inside dot-directories at any depth", async () => {
    // Next.js discovers app routes via recursiveReadDir, which only ignores
    // path parts starting with "_" (private folders) — NOT dot-directories.
    // See packages/next/src/build/route-discovery.ts (ignorePartFilter:
    // (part) => part.startsWith('_')) and packages/next/src/lib/recursive-readdir.ts.
    // So app/.well-known/openid-configuration/route.ts MUST be matched.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-scan-dot-"));
    try {
      const write = async (rel: string) => {
        const filePath = path.join(tmpDir, rel);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "export const GET = () => new Response();\n");
      };

      await write("foo/route.ts");
      await write(".well-known/openid-configuration/route.ts");
      await write("nested/.hidden/deep/route.ts");

      const found = await collectScan("**/route", tmpDir, ["ts", "tsx"]);

      expect(found).toEqual([
        ".well-known/openid-configuration/route.ts",
        "foo/route.ts",
        "nested/.hidden/deep/route.ts",
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("still prunes excluded directories while traversing dot-directories", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-scan-exclude-"));
    try {
      const write = async (rel: string) => {
        const filePath = path.join(tmpDir, rel);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "export default function Page() { return null; }\n");
      };

      await write("blog/page.tsx");
      await write(".well-known/page.tsx");
      await write("_private/page.tsx");

      const found = await collectScan("**/page", tmpDir, ["tsx"], (name) => name.startsWith("_"));

      expect(found).toEqual([".well-known/page.tsx", "blog/page.tsx"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("matches multi-dot page extensions like the previous brace-expansion glob", async () => {
    // pageExtensions can carry compound suffixes, e.g. ["platform.tsx", "tsx"]
    // from the Next.js resolve-extensions fixture (see buildViteResolveExtensions).
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-scan-ext-"));
    try {
      const write = async (rel: string) => {
        const filePath = path.join(tmpDir, rel);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "export default function Page() { return null; }\n");
      };

      await write("a/page.platform.tsx");
      await write("b/page.tsx");
      await write("c/page.module.css");

      const found = await collectScan("**/page", tmpDir, ["platform.tsx", "tsx"]);

      expect(found).toEqual(["a/page.platform.tsx", "b/page.tsx"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
