/**
 * Tests for the build-time layout classification manifest helpers.
 *
 * These helpers bridge the classifier (src/build/layout-classification.ts)
 * with the RSC entry codegen so that the per-layout static/dynamic
 * classifications computed at build time actually reach the runtime probe in
 * app-page-execution.ts.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  buildGenerateBundleReplacement,
  buildReasonsReplacement,
  collectRouteClassificationManifest,
} from "../packages/vinext/src/build/route-classification-manifest.js";
import type { ClassificationReason } from "../packages/vinext/src/build/layout-classification-types.js";

type MinimalAppRoute = {
  pattern: string;
  pagePath: string | null;
  routePath: string | null;
  layouts: string[];
  templates: string[];
  parallelSlots: [];
  loadingPath: null;
  errorPath: null;
  layoutErrorPaths: (string | null)[];
  notFoundPath: null;
  notFoundPaths: (string | null)[];
  forbiddenPaths: (string | null)[];
  forbiddenPath: null;
  unauthorizedPaths: (string | null)[];
  unauthorizedPath: null;
  routeSegments: string[];
  layoutTreePositions: number[];
  isDynamic: boolean;
  params: string[];
  patternParts: string[];
};

function makeRoute(partial: Partial<MinimalAppRoute> & { layouts: string[] }): MinimalAppRoute {
  return {
    pattern: "/",
    pagePath: null,
    routePath: null,
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: partial.layouts.map(() => null),
    notFoundPath: null,
    notFoundPaths: partial.layouts.map(() => null),
    forbiddenPaths: partial.layouts.map(() => null),
    forbiddenPath: null,
    unauthorizedPaths: partial.layouts.map(() => null),
    unauthorizedPath: null,
    routeSegments: [],
    layoutTreePositions: partial.layouts.map((_, idx) => idx),
    isDynamic: false,
    params: [],
    patternParts: [],
    ...partial,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-classification-manifest-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeLayout(name: string, source: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fsp.writeFile(file, source, "utf8");
  return file;
}

describe("collectRouteClassificationManifest", () => {
  it("reads force-dynamic layouts as dynamic", async () => {
    const layout = await writeLayout(
      "layout-dyn.tsx",
      `export const dynamic = "force-dynamic";\nexport default function L({children}){return children;}`,
    );
    const routes = [makeRoute({ pattern: "/", layouts: [layout] })];

    const manifest = collectRouteClassificationManifest(routes);

    expect(manifest.routes[0].layer1.get(0)).toBe("dynamic");
    expect(manifest.routes[0].layer1Reasons.get(0)).toEqual({
      layer: "segment-config",
      key: "dynamic",
      value: "force-dynamic",
    });
  });

  it("reads force-static layouts as static", async () => {
    const layout = await writeLayout(
      "layout-static.tsx",
      `export const dynamic = "force-static";\nexport default function L({children}){return children;}`,
    );
    const routes = [makeRoute({ pattern: "/", layouts: [layout] })];

    const manifest = collectRouteClassificationManifest(routes);

    expect(manifest.routes[0].layer1.get(0)).toBe("static");
  });

  it("leaves layouts without segment config unclassified", async () => {
    const layout = await writeLayout(
      "layout-plain.tsx",
      `export default function L({children}){return <div>{children}</div>;}`,
    );
    const routes = [makeRoute({ pattern: "/", layouts: [layout] })];

    const manifest = collectRouteClassificationManifest(routes);

    expect(manifest.routes[0].layer1.has(0)).toBe(false);
  });

  it("reads revalidate = 0 as dynamic", async () => {
    const layout = await writeLayout(
      "layout-reval0.tsx",
      `export const revalidate = 0;\nexport default function L({children}){return children;}`,
    );
    const routes = [makeRoute({ pattern: "/", layouts: [layout] })];

    const manifest = collectRouteClassificationManifest(routes);

    expect(manifest.routes[0].layer1.get(0)).toBe("dynamic");
  });

  it("throws when a layout file is missing, naming the route and path", () => {
    const missingPath = path.join(tmpDir, "nonexistent", "layout.tsx");
    const routes = [makeRoute({ pattern: "/blog", layouts: [missingPath] })];

    expect(() => collectRouteClassificationManifest(routes)).toThrow(/\/blog/);
    expect(() => collectRouteClassificationManifest(routes)).toThrow(/nonexistent/);
  });
});

describe("buildGenerateBundleReplacement", () => {
  function evalDispatch(source: string): (routeIdx: number) => unknown {
    // The helper returns a function expression suitable for:
    //   function __VINEXT_CLASS(routeIdx) { return (<replacement>)(routeIdx); }
    // Use vm.runInThisContext so the resulting Map instances share their
    // prototype with the test process — `instanceof Map` would otherwise
    // fail across v8 contexts.
    const fn: unknown = vm.runInThisContext(`(${source})`);
    if (typeof fn !== "function") {
      throw new Error("buildGenerateBundleReplacement did not produce a function expression");
    }
    return (routeIdx: number) => Reflect.apply(fn, null, [routeIdx]);
  }

  function makeManifest(
    entries: Array<{ layer1?: Array<[number, "static" | "dynamic"]> }>,
  ): Parameters<typeof buildGenerateBundleReplacement>[0] {
    return {
      routes: entries.map((e, idx) => {
        const layer1 = new Map(e.layer1 ?? []);
        const layer1Reasons = new Map<number, ClassificationReason>();
        for (const [layoutIdx, kind] of layer1) {
          layer1Reasons.set(layoutIdx, {
            layer: "segment-config",
            key: "dynamic",
            value: kind === "dynamic" ? "force-dynamic" : "force-static",
          });
        }
        return {
          pattern: `/route-${idx}`,
          layoutPaths: [],
          layer1,
          layer1Reasons,
        };
      }),
    };
  }

  it("returns a function expression that evaluates to a dispatch function", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    const replacement = buildGenerateBundleReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);

    expect(typeof dispatch).toBe("function");
    const result = dispatch(0);
    expect(result).toBeInstanceOf(Map);
  });

  function asMap(value: unknown): Map<unknown, unknown> {
    if (!(value instanceof Map)) {
      throw new Error(`Expected Map, got ${String(value)}`);
    }
    return value;
  }

  it("merges Layer 1 and Layer 2 into the dispatch function's Map", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    const layer2: Parameters<typeof buildGenerateBundleReplacement>[1] = new Map([
      [0, new Map([[1, { layer: "module-graph", result: "static" }]])],
    ]);
    const replacement = buildGenerateBundleReplacement(manifest, layer2);

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    expect(result.get(0)).toBe("dynamic");
    expect(result.get(1)).toBe("static");
  });

  it("preserves Layer 1 priority over Layer 2 for the same layout index", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    // Layer 2 proves "static" for index 0 — but Layer 1 said "dynamic", so
    // Layer 1 must win. This guards against the classifier silently demoting
    // a force-dynamic layout because the module graph happened to be clean.
    const layer2: Parameters<typeof buildGenerateBundleReplacement>[1] = new Map([
      [0, new Map([[0, { layer: "module-graph", result: "static" }]])],
    ]);
    const replacement = buildGenerateBundleReplacement(manifest, layer2);

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    expect(result.get(0)).toBe("dynamic");
  });

  it("returns null from dispatch for unknown route indices", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    const replacement = buildGenerateBundleReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);

    expect(dispatch(999)).toBeNull();
  });

  it("returns null from dispatch for routes with no classifications", () => {
    // Route 0 has Layer 1 data; route 1 has nothing in Layer 1 or Layer 2.
    // A route with no merged entries should fall through to the default case.
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }, { layer1: [] }]);
    const replacement = buildGenerateBundleReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);

    expect(dispatch(0)).toBeInstanceOf(Map);
    expect(dispatch(1)).toBeNull();
  });

  it("throws when layer1 and layer1Reasons are out of sync", () => {
    // This invariant is enforced in mergeLayersForRoute: every entry in layer1
    // must have a corresponding entry in layer1Reasons. collectRouteClassificationManifest
    // always populates them in lockstep, but callers constructing RouteManifestEntry
    // manually could violate this.
    const brokenManifest: Parameters<typeof buildGenerateBundleReplacement>[0] = {
      routes: [
        {
          pattern: "/broken",
          layoutPaths: [],
          layer1: new Map([[0, "dynamic"]]),
          layer1Reasons: new Map(), // missing reason for layoutIdx 0
        },
      ],
    };

    expect(() => buildGenerateBundleReplacement(brokenManifest, new Map())).toThrow(
      /Layer 1 decision without a reason/,
    );
  });
});

describe("buildReasonsReplacement", () => {
  function evalDispatch(source: string): (routeIdx: number) => unknown {
    const fn: unknown = vm.runInThisContext(`(${source})`);
    if (typeof fn !== "function") {
      throw new Error("buildReasonsReplacement did not produce a function expression");
    }
    return (routeIdx: number) => Reflect.apply(fn, null, [routeIdx]);
  }

  function asMap(value: unknown): Map<unknown, unknown> {
    if (!(value instanceof Map)) {
      throw new Error(`Expected Map, got ${String(value)}`);
    }
    return value;
  }

  function makeManifest(
    entries: Array<{ layer1?: Array<[number, "static" | "dynamic"]> }>,
  ): Parameters<typeof buildReasonsReplacement>[0] {
    return {
      routes: entries.map((e, idx) => {
        const layer1 = new Map(e.layer1 ?? []);
        const layer1Reasons = new Map<number, ClassificationReason>();
        for (const [layoutIdx, kind] of layer1) {
          layer1Reasons.set(layoutIdx, {
            layer: "segment-config",
            key: "dynamic",
            value: kind === "dynamic" ? "force-dynamic" : "force-static",
          });
        }
        return {
          pattern: `/route-${idx}`,
          layoutPaths: [],
          layer1,
          layer1Reasons,
        };
      }),
    };
  }

  it("returns segment-config reasons for Layer 1 decisions", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    const replacement = buildReasonsReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    expect(result.get(0)).toEqual({
      layer: "segment-config",
      key: "dynamic",
      value: "force-dynamic",
    });
  });

  it("preserves Infinity in segment-config reasons", () => {
    const manifest = {
      routes: [
        {
          pattern: "/route-0",
          layoutPaths: [],
          layer1: new Map<number, "static" | "dynamic">([[0, "static"]]),
          layer1Reasons: new Map<number, ClassificationReason>([
            [0, { layer: "segment-config", key: "revalidate", value: Infinity }],
          ]),
        },
      ],
    };
    const replacement = buildReasonsReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    expect(result.get(0)).toEqual({
      layer: "segment-config",
      key: "revalidate",
      value: Infinity,
    });
  });

  it("returns module-graph reasons for Layer 2 static decisions", () => {
    const manifest = makeManifest([{ layer1: [] }]);
    const layer2: Parameters<typeof buildReasonsReplacement>[1] = new Map([
      [0, new Map([[3, { layer: "module-graph", result: "static" }]])],
    ]);
    const replacement = buildReasonsReplacement(manifest, layer2);

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    expect(result.get(3)).toEqual({
      layer: "module-graph",
      result: "static",
    });
  });

  it("preserves Layer 1 reason priority over Layer 2 for the same layout index", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }]);
    const layer2: Parameters<typeof buildReasonsReplacement>[1] = new Map([
      [0, new Map([[0, { layer: "module-graph", result: "static" }]])],
    ]);
    const replacement = buildReasonsReplacement(manifest, layer2);

    const dispatch = evalDispatch(replacement);
    const result = asMap(dispatch(0));

    // Layer 1 wins — the reason carried must be the segment-config reason,
    // not the module-graph reason.
    expect(result.get(0)).toEqual({
      layer: "segment-config",
      key: "dynamic",
      value: "force-dynamic",
    });
  });

  it("returns null for routes with no classifications", () => {
    const manifest = makeManifest([{ layer1: [[0, "dynamic"]] }, { layer1: [] }]);
    const replacement = buildReasonsReplacement(manifest, new Map());

    const dispatch = evalDispatch(replacement);

    expect(dispatch(1)).toBeNull();
  });
});
