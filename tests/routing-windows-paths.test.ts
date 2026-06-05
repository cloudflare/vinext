import { describe, expect, it, vi } from "vite-plus/test";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";

const WINDOWS_APP_DIR = "C:\\project\\app";
const WINDOWS_PAGES_DIR = "C:\\project\\pages";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    async *glob(pattern: string, options?: { cwd?: string }) {
      if (options?.cwd === WINDOWS_PAGES_DIR && pattern === "**/*.{tsx,ts,jsx,js}") {
        yield "blog\\[slug].tsx";
      }

      if (options?.cwd === WINDOWS_APP_DIR && pattern === "**/page.{tsx,ts,jsx,js}") {
        yield "shop\\[id]\\page.tsx";
      }
    },
  };
});

describe("Windows filesystem paths", () => {
  it("normalizes Pages Router glob results before deriving routes", async () => {
    const { pagesRouter } = await import("../packages/vinext/src/routing/pages-router.js");

    const routes = await pagesRouter(WINDOWS_PAGES_DIR, undefined, createValidFileMatcher());

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      pattern: "/blog/:slug",
      patternParts: ["blog", ":slug"],
      filePath: "C:/project/pages/blog/[slug].tsx",
      isDynamic: true,
      params: ["slug"],
    });
  });

  it("normalizes App Router glob results before deriving route graph paths", async () => {
    const { buildAppRouteGraph } =
      await import("../packages/vinext/src/routing/app-route-graph.js");

    const graph = await buildAppRouteGraph(WINDOWS_APP_DIR, createValidFileMatcher());

    expect(graph.routes).toHaveLength(1);
    expect(graph.routes[0]).toMatchObject({
      pattern: "/shop/:id",
      pagePath: "C:/project/app/shop/[id]/page.tsx",
      routeSegments: ["shop", "[id]"],
      patternParts: ["shop", ":id"],
      isDynamic: true,
      params: ["id"],
    });
  });
});
