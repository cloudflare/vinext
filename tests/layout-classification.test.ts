/**
 * Layout classification tests — module graph traversal and combined
 * (segment config + module graph) classification for static/dynamic
 * layout detection.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  classifyLayoutByModuleGraph,
  classifyAllRouteLayouts,
  type ModuleInfoProvider,
} from "../packages/vinext/src/build/layout-classification.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a fake module graph for testing. Each key is a module ID,
 * and the value lists its static and dynamic imports.
 */
function createFakeModuleGraph(
  graph: Record<string, { importedIds?: string[]; dynamicImportedIds?: string[] }>,
): ModuleInfoProvider {
  return {
    getModuleInfo(id: string) {
      const entry = graph[id];
      if (!entry) return null;
      return {
        importedIds: entry.importedIds ?? [],
        dynamicImportedIds: entry.dynamicImportedIds ?? [],
      };
    },
  };
}

const DYNAMIC_SHIMS = new Set(["/shims/headers", "/shims/cache", "/shims/server"]);

// ─── classifyLayoutByModuleGraph ─────────────────────────────────────────────

describe("classifyLayoutByModuleGraph", () => {
  it('returns "static" when layout has no transitive dynamic shim imports', () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/components/nav.tsx"] },
      "/components/nav.tsx": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe("static");
  });

  it('returns "needs-probe" when headers shim is transitively imported', () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/components/auth.tsx"] },
      "/components/auth.tsx": { importedIds: ["/shims/headers"] },
      "/shims/headers": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe(
      "needs-probe",
    );
  });

  it('returns "needs-probe" when cache shim (noStore) is transitively imported', () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/shims/cache"] },
      "/shims/cache": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe(
      "needs-probe",
    );
  });

  it('returns "needs-probe" when server shim (connection) is transitively imported', () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/lib/data.ts"] },
      "/lib/data.ts": { importedIds: ["/shims/server"] },
      "/shims/server": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe(
      "needs-probe",
    );
  });

  it("handles circular imports without infinite loop", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/a.ts"] },
      "/a.ts": { importedIds: ["/b.ts"] },
      "/b.ts": { importedIds: ["/a.ts"] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe("static");
  });

  it("detects dynamic shim through deep transitive chains", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/a.ts"] },
      "/a.ts": { importedIds: ["/b.ts"] },
      "/b.ts": { importedIds: ["/c.ts"] },
      "/c.ts": { importedIds: ["/shims/headers"] },
      "/shims/headers": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe(
      "needs-probe",
    );
  });

  it("follows dynamicImportedIds (dynamic import())", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": {
        importedIds: [],
        dynamicImportedIds: ["/lazy.ts"],
      },
      "/lazy.ts": { importedIds: ["/shims/headers"] },
      "/shims/headers": { importedIds: [] },
    });

    expect(classifyLayoutByModuleGraph("/app/layout.tsx", DYNAMIC_SHIMS, graph)).toBe(
      "needs-probe",
    );
  });

  it('returns "static" when module info is null (unknown module)', () => {
    const graph = createFakeModuleGraph({});

    expect(classifyLayoutByModuleGraph("/unknown/layout.tsx", DYNAMIC_SHIMS, graph)).toBe("static");
  });
});

// ─── classifyAllRouteLayouts ─────────────────────────────────────────────────

describe("classifyAllRouteLayouts", () => {
  it("segment config takes priority over module graph", () => {
    // Layout imports headers shim, but segment config says force-static
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/shims/headers"] },
      "/shims/headers": { importedIds: [] },
    });

    const routes = [
      {
        layouts: [
          {
            moduleId: "/app/layout.tsx",
            treePosition: 0,
            segmentConfig: { code: 'export const dynamic = "force-static";' },
          },
        ],
        routeSegments: ["blog"],
      },
    ];

    const result = classifyAllRouteLayouts(routes, DYNAMIC_SHIMS, graph);
    expect(result.get("layout:/")).toBe("static");
  });

  it("deduplicates shared layout files across routes", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: [] },
      "/app/blog/layout.tsx": { importedIds: ["/shims/headers"] },
      "/shims/headers": { importedIds: [] },
    });

    const routes = [
      {
        layouts: [
          { moduleId: "/app/layout.tsx", treePosition: 0 },
          { moduleId: "/app/blog/layout.tsx", treePosition: 1 },
        ],
        routeSegments: ["blog"],
      },
      {
        layouts: [{ moduleId: "/app/layout.tsx", treePosition: 0 }],
        routeSegments: ["about"],
      },
    ];

    const result = classifyAllRouteLayouts(routes, DYNAMIC_SHIMS, graph);
    // Root layout appears in both routes but should only be classified once
    expect(result.get("layout:/")).toBe("static");
    expect(result.get("layout:/blog")).toBe("needs-probe");
    expect(result.size).toBe(2);
  });

  it("returns dynamic for force-dynamic segment config", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: [] },
    });

    const routes = [
      {
        layouts: [
          {
            moduleId: "/app/layout.tsx",
            treePosition: 0,
            segmentConfig: { code: 'export const dynamic = "force-dynamic";' },
          },
        ],
        routeSegments: [],
      },
    ];

    const result = classifyAllRouteLayouts(routes, DYNAMIC_SHIMS, graph);
    expect(result.get("layout:/")).toBe("dynamic");
  });

  it("falls through to module graph when segment config returns null", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: [] },
    });

    const routes = [
      {
        layouts: [
          {
            moduleId: "/app/layout.tsx",
            treePosition: 0,
            segmentConfig: { code: "export default function Layout() {}" },
          },
        ],
        routeSegments: [],
      },
    ];

    const result = classifyAllRouteLayouts(routes, DYNAMIC_SHIMS, graph);
    expect(result.get("layout:/")).toBe("static");
  });

  it("classifies layouts without segment configs using module graph only", () => {
    const graph = createFakeModuleGraph({
      "/app/layout.tsx": { importedIds: ["/shims/cache"] },
      "/shims/cache": { importedIds: [] },
    });

    const routes = [
      {
        layouts: [{ moduleId: "/app/layout.tsx", treePosition: 0 }],
        routeSegments: [],
      },
    ];

    const result = classifyAllRouteLayouts(routes, DYNAMIC_SHIMS, graph);
    expect(result.get("layout:/")).toBe("needs-probe");
  });
});
