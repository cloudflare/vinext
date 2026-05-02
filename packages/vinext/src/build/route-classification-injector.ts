import {
  classifyLayoutByModuleGraph,
  isStaticModuleGraphResult,
  moduleGraphReason,
  type ModuleInfoProvider,
} from "./layout-classification.js";
import type { ModuleGraphStaticReason } from "./layout-classification-types.js";
import {
  buildGenerateBundleReplacement,
  buildReasonsReplacement,
  type RouteClassificationManifest,
} from "./route-classification-manifest.js";

/**
 * Build-time route classification injection.
 *
 * Codegen describes route shape by emitting stable `__VINEXT_CLASS` stubs and
 * per-route call sites. This module owns the behavioral side of replacing
 * those stubs with build-time decisions once the final RSC module graph exists.
 */

export type RouteClassificationChunk = {
  code: string;
  fileName: string;
};

type RouteClassificationInjectionPlan =
  | { kind: "skip" }
  | {
      code: string;
      fileName: string;
      kind: "patch";
      map: null;
    };

type PlanRouteClassificationInjectionOptions = {
  canonicalizeLayoutPath?: (path: string) => string;
  chunks: readonly RouteClassificationChunk[];
  dynamicShimPaths: ReadonlySet<string>;
  enableDebugReasons: boolean;
  manifest: RouteClassificationManifest;
  moduleInfo: ModuleInfoProvider;
};

type BuildLayer2ClassificationsOptions = Pick<
  PlanRouteClassificationInjectionOptions,
  "canonicalizeLayoutPath" | "dynamicShimPaths" | "manifest" | "moduleInfo"
>;

// The `?` after the semicolon is intentional: Rolldown may or may not emit the
// trailing semicolon depending on minification settings. This regex relies on
// `__VINEXT_CLASS` retaining its name, which holds because RSC entry chunk
// bindings are not subject to scope-hoisting renames.
const CLASS_STUB_RE = /function __VINEXT_CLASS\(routeIdx\)\s*\{\s*return null;?\s*\}/;
const REASONS_STUB_RE = /function __VINEXT_CLASS_REASONS\(routeIdx\)\s*\{\s*return null;?\s*\}/;

function identityPath(path: string): string {
  return path;
}

function findClassificationChunk(
  chunks: readonly RouteClassificationChunk[],
): RouteClassificationChunk | null {
  // Skip the scan-phase build where the RSC entry code has been tree-shaken
  // out entirely. In the real RSC build the chunk that carries our runtime code
  // will reference `__VINEXT_CLASS` via per-route calls.
  const chunksMentioningStub = chunks.filter((chunk) => chunk.code.includes("__VINEXT_CLASS"));
  const chunksWithStubBody = chunksMentioningStub.filter((chunk) => CLASS_STUB_RE.test(chunk.code));
  const chunkWithStubBody = chunksWithStubBody[0];

  if (chunksMentioningStub.length === 0) {
    return null;
  }

  if (chunkWithStubBody === undefined) {
    throw new Error(
      `vinext: build-time classification — __VINEXT_CLASS is referenced in ${chunksMentioningStub
        .map((chunk) => chunk.fileName)
        .join(
          ", ",
        )} but no chunk contains the stub body. The generator and generateBundle have drifted.`,
    );
  }

  if (chunksWithStubBody.length > 1) {
    throw new Error(
      `vinext: build-time classification — expected __VINEXT_CLASS stub in exactly one RSC chunk, found ${chunksWithStubBody.length}`,
    );
  }

  return chunkWithStubBody;
}

function buildLayer2Classifications(
  options: BuildLayer2ClassificationsOptions,
): Map<number, Map<number, ModuleGraphStaticReason>> {
  const canonicalizeLayoutPath = options.canonicalizeLayoutPath ?? identityPath;
  const layer2PerRoute = new Map<number, Map<number, ModuleGraphStaticReason>>();
  const graphCache = new Map<string, ReturnType<typeof classifyLayoutByModuleGraph>>();

  for (let routeIdx = 0; routeIdx < options.manifest.routes.length; routeIdx++) {
    const route = options.manifest.routes[routeIdx]!;
    const perRoute = new Map<number, ModuleGraphStaticReason>();

    for (let layoutIdx = 0; layoutIdx < route.layoutPaths.length; layoutIdx++) {
      if (route.layer1.has(layoutIdx)) continue;

      const layoutModuleId = canonicalizeLayoutPath(route.layoutPaths[layoutIdx]!);
      // If the layout module itself is not in the graph, we have no evidence
      // either way. Do not claim it static, or we would skip the runtime probe
      // for a layout we never actually analysed.
      if (!options.moduleInfo.getModuleInfo(layoutModuleId)) continue;

      let graphResult = graphCache.get(layoutModuleId);
      if (graphResult === undefined) {
        graphResult = classifyLayoutByModuleGraph(
          layoutModuleId,
          options.dynamicShimPaths,
          options.moduleInfo,
        );
        graphCache.set(layoutModuleId, graphResult);
      }

      if (isStaticModuleGraphResult(graphResult)) {
        perRoute.set(layoutIdx, moduleGraphReason(graphResult));
      }
    }

    if (perRoute.size > 0) {
      layer2PerRoute.set(routeIdx, perRoute);
    }
  }

  return layer2PerRoute;
}

export function planRouteClassificationInjection(
  options: PlanRouteClassificationInjectionOptions,
): RouteClassificationInjectionPlan {
  const target = findClassificationChunk(options.chunks);
  if (!target) {
    return { kind: "skip" };
  }

  if (options.enableDebugReasons && !REASONS_STUB_RE.test(target.code)) {
    throw new Error(
      "vinext: build-time classification — __VINEXT_CLASS_REASONS stub is missing alongside __VINEXT_CLASS. The generator and generateBundle have drifted.",
    );
  }

  const layer2PerRoute = buildLayer2Classifications(options);
  const replacement = buildGenerateBundleReplacement(options.manifest, layer2PerRoute);
  const patchedBody = `function __VINEXT_CLASS(routeIdx) { return (${replacement})(routeIdx); }`;
  let code = target.code.replace(CLASS_STUB_RE, patchedBody);

  if (options.enableDebugReasons) {
    const reasonsReplacement = buildReasonsReplacement(options.manifest, layer2PerRoute);
    const patchedReasonsBody = `function __VINEXT_CLASS_REASONS(routeIdx) { return (${reasonsReplacement})(routeIdx); }`;
    code = code.replace(REASONS_STUB_RE, patchedReasonsBody);
  }

  return {
    code,
    fileName: target.fileName,
    kind: "patch",
    map: null,
  };
}
