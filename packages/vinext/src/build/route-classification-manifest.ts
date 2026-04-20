/**
 * Build-time layout classification manifest.
 *
 * Bridges the classifier in `./layout-classification.ts` with the RSC entry
 * codegen so that the per-layout static/dynamic classifications produced at
 * build time are visible to the runtime probe loop in
 * `server/app-page-execution.ts`.
 *
 * The runtime probe looks up entries by numeric `layoutIndex`, so this module
 * is responsible for flattening the classifier's string-keyed layout IDs into
 * a per-route, index-keyed structure that can be emitted from codegen.
 */

import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import type {
  ClassificationReason,
  LayoutBuildClassification,
  ModuleGraphStaticReason,
} from "./layout-classification-types.js";
import { classifyLayoutSegmentConfig } from "./report.js";

export type Layer1Class = "static" | "dynamic";

export type RouteManifestEntry = {
  /** Route pattern for diagnostics (e.g. "/blog/:slug"). */
  pattern: string;
  /** Absolute file paths for each layout, ordered root → leaf. */
  layoutPaths: string[];
  /** Layer 1 (segment config) results keyed by numeric layout index. */
  layer1: Map<number, Layer1Class>;
  /**
   * Structured reasons for every Layer 1 decision, keyed by the same layout
   * index. Always populated in lockstep with `layer1` so the debug channel
   * can surface which segment-config field produced the decision.
   */
  layer1Reasons: Map<number, ClassificationReason>;
};

export type RouteClassificationManifest = {
  routes: RouteManifestEntry[];
};

/**
 * Reads each layout's source at build time and runs Layer 1 segment-config
 * classification. Fails loudly if any layout file is missing — a missing
 * layout means the routing scan and the filesystem have drifted, and shipping
 * a build in that state would silently break layout rendering.
 */
export function collectRouteClassificationManifest(
  routes: readonly AppRoute[],
): RouteClassificationManifest {
  const manifestRoutes: RouteManifestEntry[] = [];
  const sourceCache = new Map<string, string>();

  for (const route of routes) {
    const layer1 = new Map<number, Layer1Class>();
    const layer1Reasons = new Map<number, ClassificationReason>();

    for (let layoutIndex = 0; layoutIndex < route.layouts.length; layoutIndex++) {
      const layoutPath = route.layouts[layoutIndex]!;
      let source = sourceCache.get(layoutPath);
      if (source === undefined) {
        try {
          source = fs.readFileSync(layoutPath, "utf8");
          sourceCache.set(layoutPath, source);
        } catch (cause) {
          throw new Error(
            `vinext: failed to read layout for route ${route.pattern} at ${layoutPath}`,
            { cause },
          );
        }
      }
      const result = classifyLayoutSegmentConfig(source);
      if (result.kind === "static" || result.kind === "dynamic") {
        layer1.set(layoutIndex, result.kind);
        layer1Reasons.set(layoutIndex, result.reason);
      }
    }

    manifestRoutes.push({
      pattern: route.pattern,
      layoutPaths: [...route.layouts],
      layer1,
      layer1Reasons,
    });
  }

  return { routes: manifestRoutes };
}

/**
 * Merge output entry. `mergeLayersForRoute` never emits the `absent` variant
 * of `LayoutBuildClassification`, so this narrows the type and lets
 * downstream callers read `.reason` without branching on `kind`.
 */
type MergedLayoutClassification = Exclude<LayoutBuildClassification, { kind: "absent" }>;

/**
 * Merges Layer 1 (segment config) and Layer 2 (module graph) into a single
 * per-route map, applying the Layer-1-wins priority rule.
 *
 * Layer 1 always takes priority over Layer 2 for the same layout index:
 * segment config is a user-authored guarantee, so a layout that explicitly
 * says `force-dynamic` must never be demoted to "static" because its module
 * graph happened to be clean.
 */
function mergeLayersForRoute(
  route: RouteManifestEntry,
  layer2: ReadonlyMap<number, ModuleGraphStaticReason> | undefined,
): Map<number, MergedLayoutClassification> {
  const merged = new Map<number, MergedLayoutClassification>();

  if (layer2) {
    for (const [layoutIdx, reason] of layer2) {
      merged.set(layoutIdx, {
        kind: "static",
        reason,
      });
    }
  }

  for (const [layoutIdx, kind] of route.layer1) {
    const reason = route.layer1Reasons.get(layoutIdx);
    if (reason === undefined) {
      throw new Error(
        `vinext: layout ${layoutIdx} in route ${route.pattern} has a Layer 1 decision without a reason`,
      );
    }
    merged.set(layoutIdx, { kind, reason });
  }

  return merged;
}

function serializeReasonExpression(reason: ClassificationReason): string {
  switch (reason.layer) {
    case "segment-config": {
      // Infinity must be checked first: JSON.stringify(Infinity) produces "null".
      const value = reason.value === Infinity ? "Infinity" : JSON.stringify(reason.value);
      return `{ layer: "segment-config", key: ${JSON.stringify(reason.key)}, value: ${value} }`;
    }
    case "module-graph": {
      const props = [`layer: "module-graph"`, `result: ${JSON.stringify(reason.result)}`];
      if (reason.firstShimMatch !== undefined) {
        props.push(`firstShimMatch: ${JSON.stringify(reason.firstShimMatch)}`);
      }
      return `{ ${props.join(", ")} }`;
    }
    // The two arms below are not reachable from the current build-time pipeline
    // (only segment-config and module-graph reasons flow into this function).
    // They are present for type exhaustiveness and so that #843's debug sidecar
    // can extend this function to cover all ClassificationReason variants without
    // a separate serializer. Narrowing the parameter type to only the build-time
    // variants requires propagating through LayoutBuildClassification in report.ts;
    // deferred to a follow-up.
    case "runtime-probe": {
      const props = [`layer: "runtime-probe"`, `outcome: ${JSON.stringify(reason.outcome)}`];
      if (reason.error !== undefined) {
        props.push(`error: ${JSON.stringify(reason.error)}`);
      }
      return `{ ${props.join(", ")} }`;
    }
    case "no-classifier":
      return `{ layer: "no-classifier" }`;
  }
}

function buildRouteDispatchReplacement(
  manifest: RouteClassificationManifest,
  layer2PerRoute: ReadonlyMap<number, ReadonlyMap<number, ModuleGraphStaticReason>>,
  serializeEntry: (value: MergedLayoutClassification) => string,
): string {
  const cases: string[] = [];

  for (let routeIdx = 0; routeIdx < manifest.routes.length; routeIdx++) {
    const route = manifest.routes[routeIdx]!;
    const merged = mergeLayersForRoute(route, layer2PerRoute.get(routeIdx));

    if (merged.size === 0) continue;

    const entries = [...merged.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, value]) => `[${idx}, ${serializeEntry(value)}]`)
      .join(", ");
    cases.push(`      case ${routeIdx}: return new Map([${entries}]);`);
  }

  return [
    "(routeIdx) => {",
    "    switch (routeIdx) {",
    ...cases,
    "      default: return null;",
    "    }",
    "  }",
  ].join("\n");
}

/**
 * Builds a JavaScript arrow-function expression that dispatches route index
 * to a pre-computed `Map<layoutIndex, "static" | "dynamic">` of build-time
 * classifications. The returned string is suitable for embedding into the
 * generated RSC entry via `generateBundle`.
 *
 * `layer2PerRoute` is typed to only carry `"static"` entries — the
 * module-graph classifier can only prove static, so "needs-probe" results
 * are omitted by the caller before this map is constructed.
 */
export function buildGenerateBundleReplacement(
  manifest: RouteClassificationManifest,
  layer2PerRoute: ReadonlyMap<number, ReadonlyMap<number, ModuleGraphStaticReason>>,
): string {
  return buildRouteDispatchReplacement(manifest, layer2PerRoute, (value) =>
    JSON.stringify(value.kind),
  );
}

/**
 * Sibling of `buildGenerateBundleReplacement`: emits a dispatch function
 * that returns `Map<layoutIndex, ClassificationReason>` per route.
 *
 * The runtime consults this map only when `VINEXT_DEBUG_CLASSIFICATION` is
 * set, and the plugin only patches this dispatcher into the built bundle when
 * that env var is present at build time.
 *
 * Layer 1 priority applies the same way as in `buildGenerateBundleReplacement`:
 * a segment-config reason must override a module-graph reason for the same
 * layout index.
 */
export function buildReasonsReplacement(
  manifest: RouteClassificationManifest,
  layer2PerRoute: ReadonlyMap<number, ReadonlyMap<number, ModuleGraphStaticReason>>,
): string {
  return buildRouteDispatchReplacement(manifest, layer2PerRoute, (value) =>
    serializeReasonExpression(value.reason),
  );
}
