import type { AppRoute } from "../routing/app-router.js";
import { collectAppRouteAssetModuleFiles } from "./app-route-module-files.js";
import {
  collectDevCssHrefsForFiles,
  type DevCssImportsCache,
  type DevCssResolutionContext,
} from "./dev-css-imports.js";

type RouteAssetManifestEntry = {
  routeId: string;
  cssHrefs: readonly string[];
};

type RouteAssetManifest = {
  routes: Readonly<Record<string, RouteAssetManifestEntry>>;
};

function getRouteAssetId(route: AppRoute): string {
  return route.ids?.route ?? route.pattern;
}

export async function buildDevRouteAssetManifest(
  routes: readonly AppRoute[],
  context: DevCssResolutionContext,
  cache: DevCssImportsCache = new Map(),
): Promise<RouteAssetManifest> {
  const entries = await Promise.all(
    routes.map(async (route) => {
      const routeId = getRouteAssetId(route);
      const cssHrefs = await collectDevCssHrefsForFiles(
        collectAppRouteAssetModuleFiles(route),
        context,
        cache,
      );
      return [routeId, { routeId, cssHrefs }] as const;
    }),
  );

  return { routes: Object.fromEntries(entries) };
}

export function getRouteCssHrefsInRouteOrder(
  manifest: RouteAssetManifest,
  routes: readonly AppRoute[],
): readonly (readonly string[])[] {
  return routes.map((route) => manifest.routes[getRouteAssetId(route)]?.cssHrefs ?? []);
}
