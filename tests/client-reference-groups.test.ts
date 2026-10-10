import { describe, expect, it } from "vite-plus/test";
import { hasUserClientChunkGroups } from "../packages/vinext/src/build/client-build-config.js";
import {
  collectClientReferenceRouteSignatures,
  measureClientReferenceGroupCosts,
  planClientReferenceGroups,
} from "../packages/vinext/src/build/client-reference-groups.js";

function route(pattern: string, pagePath: string, layouts: string[] = []) {
  return {
    errorPath: null,
    errorPaths: [],
    forbiddenPath: null,
    forbiddenPaths: [],
    layoutErrorPaths: [],
    layouts,
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    pattern,
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

function moduleInfo(graph: Record<string, string[]>, dynamicGraph: Record<string, string[]> = {}) {
  return (id: string) => ({
    dynamicallyImportedIds: dynamicGraph[id] ?? [],
    importedIds: graph[id] ?? [],
  });
}

function loader(modules: Record<string, { bytes: number; imports?: string[] }>) {
  return async (id: string) => {
    const module = modules[id];
    if (!module) throw new Error(`missing ${id}`);
    return { code: "x".repeat(module.bytes), importedIds: module.imports ?? [] };
  };
}

describe("collectClientReferenceRouteSignatures", () => {
  it("signs references by the routes that reach them, except below dynamic imports", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set([
        "/nav.tsx",
        "/theme.tsx",
        "/chart.tsx",
        "/lazy.tsx",
        "/lazy-panel.tsx",
        "/orphan",
      ]),
      getModuleInfo: moduleInfo(
        {
          "/app/layout.tsx": ["/header.tsx", "/theme.tsx"],
          "/header.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx", "/nav.tsx"],
          "/about/lazy-section.tsx": ["/lazy-panel.tsx"],
        },
        { "/app/about/page.tsx": ["/lazy.tsx", "/about/lazy-section.tsx"] },
      ),
      root: "/",
      routes: [
        route("/", "/app/page.tsx", ["/app/layout.tsx"]),
        route("/about", "/app/about/page.tsx", ["/app/layout.tsx"]),
      ],
    });

    expect(Object.fromEntries(signatures)).toEqual({
      "/chart.tsx": "/",
      "/nav.tsx": "/\n/about",
      "/theme.tsx": "/\n/about",
    });
  });

  it("gives intercepts and shared roots their own file owners", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set([
        "/retry.tsx",
        "/search.tsx",
        "/modal.tsx",
        "/drawer.tsx",
        "/grid.tsx",
      ]),
      getModuleInfo: moduleInfo({
        "/repo/app/global-error.tsx": ["/retry.tsx"],
        "/repo/app/global-not-found.tsx": ["/search.tsx"],
        "/repo/app/photos/page.tsx": ["/grid.tsx"],
        "/repo/app/@modal/(.)photo/page.tsx": ["/modal.tsx"],
        "/repo/app/photos/@drawer/(.)photo/page.tsx": ["/drawer.tsx"],
      }),
      root: "/repo",
      routes: [
        {
          ...route("/photos", "/repo/app/photos/page.tsx"),
          parallelSlots: [
            {
              interceptingRoutes: [
                {
                  layoutPaths: [],
                  notFoundPath: null,
                  pagePath: "/repo/app/photos/@drawer/(.)photo/page.tsx",
                },
              ],
            },
          ],
          siblingIntercepts: [
            { layoutPaths: [], notFoundPath: null, pagePath: "/repo/app/@modal/(.)photo/page.tsx" },
          ],
        } as never,
      ],
      sharedRoots: ["/repo/app/global-error.tsx", "/repo/app/global-not-found.tsx"],
    });

    expect(Object.fromEntries(signatures)).toEqual({
      "/grid.tsx": "/photos",
      "/modal.tsx": "app/@modal/(.)photo/page.tsx",
      "/drawer.tsx": "app/photos/@drawer/(.)photo/page.tsx",
      "/retry.tsx": "app/global-error.tsx",
      "/search.tsx": "app/global-not-found.tsx",
    });
  });

  it("does not walk through client references", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/client.tsx", "/inner.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/client.tsx"],
        "/client.tsx": ["/inner.tsx"],
      }),
      root: "/",
      routes: [route("/", "/app/page.tsx")],
    });

    expect([...signatures.keys()]).toEqual(["/client.tsx"]);
  });

  it("orders references by module evaluation order", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/a.tsx", "/b.tsx", "/c.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/helper.ts", "/a.tsx", "/c.tsx"],
        "/helper.ts": ["/b.tsx", "/c.tsx"],
      }),
      root: "/",
      routes: [route("/", "/app/page.tsx")],
    });

    expect([...signatures.keys()]).toEqual(["/b.tsx", "/c.tsx", "/a.tsx"]);
  });

  it("canonicalizes route files before walking the module graph", () => {
    const signatures = collectClientReferenceRouteSignatures({
      canonicalizeModuleId: (id) => id.replace("/var/", "/private/var/"),
      clientReferenceIds: new Set(["/nav.tsx"]),
      getModuleInfo: moduleInfo({ "/private/var/app/page.tsx": ["/nav.tsx"] }),
      root: "/var",
      routes: [route("/", "/var/app/page.tsx")],
    });

    expect(signatures.get("/nav.tsx")).toBe("/");
  });
});

describe("measureClientReferenceGroupCosts", () => {
  it("charges each reference for its own modules but not shared ones", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["b", "/b.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a-only.ts", "/shared.ts"] },
        "/b.tsx": { bytes: 20, imports: ["/shared.ts"] },
        "/a-only.ts": { bytes: 100 },
        "/shared.ts": { bytes: 1000 },
      }),
      isExcluded: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 110, b: 20 });
  });

  it("charges a reference for the client references it statically imports", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["box", "/box.tsx"],
        ["code", "/code.tsx"],
      ]),
      loadModule: loader({
        "/box.tsx": { bytes: 10, imports: ["/code.tsx"] },
        "/code.tsx": { bytes: 50, imports: ["/highlighter.ts"] },
        "/highlighter.ts": { bytes: 5000 },
      }),
      isExcluded: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ box: 5060, code: 5050 });
  });

  it("measures UTF-8 bytes", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([["a", "/a.tsx"]]),
      loadModule: async () => ({ code: "é".repeat(10), importedIds: [] }),
      isExcluded: () => false,
    });

    expect(costs.get("a")).toBe(20);
  });

  it("skips excluded modules and reports unloadable graphs as unknown", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["broken", "/broken.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a.css", "/react.js"] },
        "/broken.tsx": { bytes: 10, imports: ["/missing.ts"] },
      }),
      isExcluded: (id) => id.endsWith(".css") || id === "/react.js",
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 10, broken: null });
  });
});

describe("planClientReferenceGroups", () => {
  const signatures = new Map([
    ["/b.tsx", "/"],
    ["/a.tsx", "/"],
    ["/heavy.tsx", "/"],
    ["/unknown.tsx", "/"],
    ["/solo.tsx", "/about"],
    ["/x.tsx", "/blog"],
    ["/y.tsx", "/blog"],
  ]);
  const costs = new Map<string, number | null>([
    ["/a.tsx", 10],
    ["/b.tsx", 10],
    ["/heavy.tsx", 1000],
    ["/unknown.tsx", null],
    ["/solo.tsx", 10],
    ["/x.tsx", 10],
    ["/y.tsx", 10],
  ]);

  it("groups references that share a signature and stay under the cost cap", () => {
    const groups = planClientReferenceGroups({
      referenceIds: new Set([...signatures.keys(), "/unsigned.tsx"]),
      signatures,
      costs,
      maxCostBytes: 100,
    });

    // Members keep signature (route walk) order.
    expect(groups.map((group) => group.referenceIds)).toEqual([
      ["/b.tsx", "/a.tsx"],
      ["/x.tsx", "/y.tsx"],
    ]);
    for (const group of groups) expect(group.key).toMatch(/^[0-9a-f]{10}$/);
  });

  it("derives stable keys from the signature", () => {
    const plan = () =>
      planClientReferenceGroups({
        referenceIds: new Set([...signatures.keys()].reverse()),
        signatures,
        costs,
        maxCostBytes: 100,
      }).map((group) => group.key);

    expect(plan()).toEqual(plan());
    expect(new Set(plan()).size).toBe(2);
  });
});

describe("hasUserClientChunkGroups", () => {
  const ownGroup = { name: () => null };
  const own = new Set<unknown>([ownGroup]);

  it("ignores vinext's own groups and code splitting options without groups", () => {
    expect(hasUserClientChunkGroups(undefined, own)).toBe(false);
    expect(
      hasUserClientChunkGroups({ codeSplitting: { minSize: 10_000, groups: [ownGroup] } }, own),
    ).toBe(false);
    expect(hasUserClientChunkGroups({ codeSplitting: true }, own)).toBe(false);
  });

  it("detects any other chunk group or manualChunks", () => {
    expect(
      hasUserClientChunkGroups({ codeSplitting: { groups: [ownGroup, { name: "vendor" }] } }, own),
    ).toBe(true);
    expect(hasUserClientChunkGroups([{ manualChunks: () => undefined }], own)).toBe(true);
    expect(hasUserClientChunkGroups({ advancedChunks: { groups: [{ name: "x" }] } }, own)).toBe(
      true,
    );
  });
});
