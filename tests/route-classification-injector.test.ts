import { describe, expect, it } from "vite-plus/test";
import { planRouteClassificationInjection } from "../packages/vinext/src/build/route-classification-injector.js";
import type { RouteClassificationManifest } from "../packages/vinext/src/build/route-classification-manifest.js";

function makeManifest(): RouteClassificationManifest {
  return {
    routes: [
      {
        pattern: "/",
        layoutPaths: ["/app/layout.tsx", "/app/blog/layout.tsx"],
        layer1: new Map([[0, "dynamic"]]),
        layer1Reasons: new Map([
          [
            0,
            {
              layer: "segment-config",
              key: "dynamic",
              value: "force-dynamic",
            },
          ],
        ]),
      },
    ],
  };
}

function makeChunk(code: string, fileName = "server/app.js") {
  return {
    code,
    fileName,
  };
}

const STUBS = [
  "function __VINEXT_CLASS(routeIdx) { return null; }",
  "function __VINEXT_CLASS_REASONS(routeIdx) { return null; }",
  "const route = { __buildTimeClassifications: __VINEXT_CLASS(0) };",
].join("\n");

describe("planRouteClassificationInjection", () => {
  it("skips chunks that do not mention the classification dispatch", () => {
    const plan = planRouteClassificationInjection({
      chunks: [makeChunk("export const value = 1;")],
      dynamicShimPaths: new Set(),
      enableDebugReasons: false,
      manifest: makeManifest(),
      moduleInfo: {
        getModuleInfo() {
          return null;
        },
      },
    });

    expect(plan.kind).toBe("skip");
  });

  it("patches the classification stub and invalidates the target source map", () => {
    const plan = planRouteClassificationInjection({
      chunks: [makeChunk(STUBS)],
      dynamicShimPaths: new Set(),
      enableDebugReasons: false,
      manifest: makeManifest(),
      moduleInfo: {
        getModuleInfo(moduleId) {
          if (moduleId === "/app/blog/layout.tsx") {
            return { importedIds: [], dynamicImportedIds: [] };
          }
          return null;
        },
      },
    });

    expect(plan).toMatchObject({
      kind: "patch",
      fileName: "server/app.js",
      map: null,
    });
    if (plan.kind !== "patch") throw new Error("Expected patch plan");
    expect(plan.code).not.toContain("function __VINEXT_CLASS(routeIdx) { return null; }");
    expect(plan.code).toContain("function __VINEXT_CLASS(routeIdx) { return ((routeIdx) => {");
    expect(plan.code).toContain('case 0: return new Map([[0, "dynamic"], [1, "static"]]);');
    expect(plan.code).toContain("function __VINEXT_CLASS_REASONS(routeIdx) { return null; }");
  });

  it("does not claim a layout static when the seed module is absent from the graph", () => {
    const plan = planRouteClassificationInjection({
      chunks: [makeChunk(STUBS)],
      dynamicShimPaths: new Set(),
      enableDebugReasons: false,
      manifest: makeManifest(),
      moduleInfo: {
        getModuleInfo() {
          return null;
        },
      },
    });

    if (plan.kind !== "patch") throw new Error("Expected patch plan");
    expect(plan.code).toContain('case 0: return new Map([[0, "dynamic"]]);');
    expect(plan.code).not.toContain('[1, "static"]');
  });

  it("patches the debug reasons sidecar when debug reasons are enabled", () => {
    const plan = planRouteClassificationInjection({
      chunks: [makeChunk(STUBS)],
      dynamicShimPaths: new Set(),
      enableDebugReasons: true,
      manifest: makeManifest(),
      moduleInfo: {
        getModuleInfo(moduleId) {
          if (moduleId === "/app/blog/layout.tsx") {
            return { importedIds: [], dynamicImportedIds: [] };
          }
          return null;
        },
      },
    });

    if (plan.kind !== "patch") throw new Error("Expected patch plan");
    expect(plan.code).not.toContain("function __VINEXT_CLASS_REASONS(routeIdx) { return null; }");
    expect(plan.code).toContain(
      "function __VINEXT_CLASS_REASONS(routeIdx) { return ((routeIdx) => {",
    );
    expect(plan.code).toContain('[1, { layer: "module-graph", result: "static" }]');
  });

  it("fails loudly when the dispatch is referenced but the stub body is absent", () => {
    expect(() =>
      planRouteClassificationInjection({
        chunks: [makeChunk("const route = { __buildTimeClassifications: __VINEXT_CLASS(0) };")],
        dynamicShimPaths: new Set(),
        enableDebugReasons: false,
        manifest: makeManifest(),
        moduleInfo: {
          getModuleInfo() {
            return null;
          },
        },
      }),
    ).toThrow(/referenced in server\/app\.js but no chunk contains the stub body/);
  });

  it("fails loudly when multiple chunks contain the dispatch stub body", () => {
    expect(() =>
      planRouteClassificationInjection({
        chunks: [makeChunk(STUBS, "server/app-a.js"), makeChunk(STUBS, "server/app-b.js")],
        dynamicShimPaths: new Set(),
        enableDebugReasons: false,
        manifest: makeManifest(),
        moduleInfo: {
          getModuleInfo() {
            return null;
          },
        },
      }),
    ).toThrow(/expected __VINEXT_CLASS stub in exactly one RSC chunk, found 2/);
  });

  it("fails loudly when debug reasons are enabled but the reasons stub is missing", () => {
    expect(() =>
      planRouteClassificationInjection({
        chunks: [
          makeChunk(
            [
              "function __VINEXT_CLASS(routeIdx) { return null; }",
              "const route = { __buildTimeClassifications: __VINEXT_CLASS(0) };",
            ].join("\n"),
          ),
        ],
        dynamicShimPaths: new Set(),
        enableDebugReasons: true,
        manifest: makeManifest(),
        moduleInfo: {
          getModuleInfo() {
            return null;
          },
        },
      }),
    ).toThrow(/__VINEXT_CLASS_REASONS stub is missing/);
  });
});
