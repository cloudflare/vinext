import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAppRouteGraph } from "../packages/vinext/src/routing/app-route-graph.js";
import {
  createValidFileMatcher,
  scanWithExtensions,
} from "../packages/vinext/src/routing/file-matcher.js";
import { invalidateRouteCache, pagesRouter } from "../packages/vinext/src/routing/pages-router.js";

const mockedGlob = vi.hoisted(() => ({
  entries: new Map<string, string[]>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    glob: async function* (pattern: string | string[], options?: { cwd?: string }) {
      const key = `${options?.cwd ?? ""}\0${String(pattern)}`;
      for (const file of mockedGlob.entries.get(key) ?? []) {
        yield file;
      }
    },
  };
});

vi.mock("../packages/vinext/src/utils/path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/vinext/src/utils/path.js")>();
  return { ...actual, normalizePathSeparators: (p: string) => p.replace(/\\/g, "/") };
});

const DEFAULT_PAGE_GLOB = "**/*.{tsx,ts,jsx,js}";
const DEFAULT_APP_PAGE_GLOB = "**/page.{tsx,ts,jsx,js}";
const DEFAULT_APP_ROUTE_GLOB = "**/route.{tsx,ts,jsx,js}";
const DEFAULT_APP_LAYOUT_GLOB = "**/layout.{tsx,ts,jsx,js}";
const EMPTY_PAGE = "export default function Page() { return null; }\n";
const EMPTY_LAYOUT = "export default function Layout({ children }) { return children; }\n";

beforeEach(() => {
  mockedGlob.entries.clear();
});

function mockGlob(cwd: string, pattern: string, entries: string[]): void {
  mockedGlob.entries.set(`${cwd}\0${pattern}`, entries);
}

function toSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function withTempDir<T>(prefix: string, run: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

describe("Windows path normalization", () => {
  it("normalizes fs.glob results before routing code consumes them", async () => {
    await withTempDir("vinext-windows-glob-", async (tmpDir) => {
      mockGlob(tmpDir, "**/*.tsx", ["dashboard\\page.tsx"]);

      const files: string[] = [];
      for await (const file of scanWithExtensions("**/*", tmpDir, ["tsx"])) {
        files.push(file);
      }

      expect(files).toEqual(["dashboard/page.tsx"]);
    });
  });

  it("builds Pages Router patterns and file paths from Windows-style scanner output", async () => {
    await withTempDir("vinext-windows-pages-router-", async (tmpDir) => {
      const pagesDir = path.join(tmpDir, "pages");
      await mkdir(pagesDir, { recursive: true });
      mockGlob(pagesDir, DEFAULT_PAGE_GLOB, ["blog\\[slug].tsx"]);
      invalidateRouteCache(pagesDir);

      const routes = await pagesRouter(pagesDir);

      expect(routes).toMatchObject([
        {
          pattern: "/blog/:slug",
          patternParts: ["blog", ":slug"],
          filePath: toSlash(path.join(pagesDir, "blog/[slug].tsx")),
        },
      ]);
    });
  });

  it("builds App Router routes and graph paths from Windows-style scanner output", async () => {
    await withTempDir("vinext-windows-app-router-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "dashboard"), { recursive: true });
      await writeFile(path.join(appDir, "layout.tsx"), EMPTY_LAYOUT);
      await writeFile(path.join(appDir, "dashboard", "page.tsx"), EMPTY_PAGE);
      mockGlob(appDir, DEFAULT_APP_PAGE_GLOB, ["dashboard\\page.tsx"]);
      mockGlob(appDir, DEFAULT_APP_ROUTE_GLOB, []);
      mockGlob(appDir, DEFAULT_APP_LAYOUT_GLOB, []);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const dashboard = graph.routes.find((route) => route.pattern === "/dashboard");

      expect(dashboard).toBeDefined();
      expect(dashboard?.routeSegments).toEqual(["dashboard"]);
      expect(dashboard?.pagePath).toBe(toSlash(path.join(appDir, "dashboard/page.tsx")));
      expect(dashboard?.layouts).toEqual([toSlash(path.join(appDir, "layout.tsx"))]);
    });
  });
});
