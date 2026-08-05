import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Rollup } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";

type ActionOwnerRoute = Pick<
  AppRoute,
  | "errorPath"
  | "errorPaths"
  | "forbiddenPath"
  | "forbiddenPaths"
  | "layoutErrorPaths"
  | "layouts"
  | "loadingPath"
  | "loadingPaths"
  | "notFoundPath"
  | "notFoundPaths"
  | "pagePath"
  | "parallelSlots"
  | "pattern"
  | "siblingIntercepts"
  | "templates"
  | "unauthorizedPath"
  | "unauthorizedPaths"
>;

export type ActionOwnerRouteReachability = Map<
  string,
  {
    clientReferenceImportIds: Set<string>;
    serverReferenceIds: Set<string>;
  }
>;

type ActionOwnerModuleInfo = Pick<Rollup.ModuleInfo, "dynamicallyImportedIds" | "importedIds">;

type ActionOwnerReferenceMaps = {
  clientReferenceMetaMap: RscPluginManager["clientReferenceMetaMap"];
  serverReferenceMetaMap: RscPluginManager["serverReferences"]["metaMap"];
};

export function actionOwnerRouteEntryIds(route: ActionOwnerRoute): string[] {
  return [
    route.pagePath,
    ...route.layouts,
    ...route.templates,
    route.loadingPath,
    ...(route.loadingPaths ?? []),
    route.errorPath,
    ...(route.layoutErrorPaths ?? []),
    ...(route.errorPaths ?? []),
    route.notFoundPath,
    ...(route.notFoundPaths ?? []),
    route.forbiddenPath,
    ...(route.forbiddenPaths ?? []),
    route.unauthorizedPath,
    ...(route.unauthorizedPaths ?? []),
    ...route.parallelSlots.flatMap((slot) => [
      slot.pagePath,
      slot.defaultPath,
      slot.layoutPath,
      ...(slot.configLayoutPaths ?? []),
      slot.loadingPath,
      ...(slot.loadingPaths ?? []),
      slot.errorPath,
      slot.notFoundPath,
      ...slot.interceptingRoutes.flatMap((intercept) => [
        intercept.pagePath,
        ...intercept.layoutPaths,
        ...(intercept.loadingPaths ?? []),
        intercept.notFoundPath,
      ]),
    ]),
    ...route.siblingIntercepts.flatMap((intercept) => [
      intercept.pagePath,
      ...intercept.layoutPaths,
      ...(intercept.loadingPaths ?? []),
      intercept.notFoundPath,
    ]),
  ].filter((value): value is string => typeof value === "string");
}

export function collectReachableActionReferences(
  options: {
    canonicalizeModuleId?: (id: string) => string;
    getModuleInfo: (id: string) => ActionOwnerModuleInfo | null;
    roots: readonly string[];
  } & ActionOwnerReferenceMaps,
): {
  clientReferenceImportIds: Set<string>;
  serverReferenceIds: Set<string>;
} {
  const canonicalizeModuleId = options.canonicalizeModuleId ?? ((id: string) => id);
  const clientReferenceImportIds = new Set<string>();
  const serverReferenceIds = new Set<string>();
  const visited = new Set<string>();
  const queue = options.roots.map(canonicalizeModuleId);

  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);

    const clientReference = options.clientReferenceMetaMap[id];
    if (clientReference) {
      clientReferenceImportIds.add(clientReference.importId);
    }

    const serverReference = options.serverReferenceMetaMap.get(id);
    if (serverReference) {
      for (const exportName of serverReference.exportNames) {
        serverReferenceIds.add(`${serverReference.referenceKey}#${exportName}`);
      }
    }

    const info = options.getModuleInfo(id);
    for (const importedId of [
      ...(info?.importedIds ?? []),
      ...(info?.dynamicallyImportedIds ?? []),
    ]) {
      if (!visited.has(importedId)) queue.push(importedId);
    }
  }

  return { clientReferenceImportIds, serverReferenceIds };
}

export function collectRscActionReachability(
  options: {
    canonicalizeModuleId?: (id: string) => string;
    getModuleInfo: (id: string) => ActionOwnerModuleInfo | null;
    routes: readonly ActionOwnerRoute[];
    sharedRoots?: readonly string[];
  } & ActionOwnerReferenceMaps,
): ActionOwnerRouteReachability {
  const routeReachability: ActionOwnerRouteReachability = new Map(
    options.routes.map((route) => [
      route.pattern,
      collectReachableActionReferences({
        canonicalizeModuleId: options.canonicalizeModuleId,
        clientReferenceMetaMap: options.clientReferenceMetaMap,
        getModuleInfo: options.getModuleInfo,
        roots: actionOwnerRouteEntryIds(route),
        serverReferenceMetaMap: options.serverReferenceMetaMap,
      }),
    ]),
  );
  if (options.sharedRoots?.length) {
    routeReachability.set(
      "*",
      collectReachableActionReferences({
        canonicalizeModuleId: options.canonicalizeModuleId,
        clientReferenceMetaMap: options.clientReferenceMetaMap,
        getModuleInfo: options.getModuleInfo,
        roots: options.sharedRoots,
        serverReferenceMetaMap: options.serverReferenceMetaMap,
      }),
    );
  }
  return routeReachability;
}

export async function resolveClientReferenceImportIds(options: {
  canonicalizeModuleId?: (id: string) => string;
  resolveId: (id: string) => Promise<string | null>;
  routeReachability: ActionOwnerRouteReachability;
}): Promise<void> {
  const canonicalizeModuleId = options.canonicalizeModuleId ?? ((id: string) => id);
  for (const reachability of options.routeReachability.values()) {
    const resolvedImportIds = new Set<string>();
    for (const importId of reachability.clientReferenceImportIds) {
      const resolvedId = (await options.resolveId(importId)) ?? importId;
      resolvedImportIds.add(canonicalizeModuleId(resolvedId));
    }
    reachability.clientReferenceImportIds = resolvedImportIds;
  }
}

export function addClientActionReachability(
  options: {
    canonicalizeModuleId?: (id: string) => string;
    getModuleInfo: (id: string) => ActionOwnerModuleInfo | null;
    routeReachability: ActionOwnerRouteReachability;
  } & ActionOwnerReferenceMaps,
): void {
  for (const reachability of options.routeReachability.values()) {
    const clientReachability = collectReachableActionReferences({
      canonicalizeModuleId: options.canonicalizeModuleId,
      clientReferenceMetaMap: options.clientReferenceMetaMap,
      getModuleInfo: options.getModuleInfo,
      roots: [...reachability.clientReferenceImportIds],
      serverReferenceMetaMap: options.serverReferenceMetaMap,
    });
    for (const actionId of clientReachability.serverReferenceIds) {
      reachability.serverReferenceIds.add(actionId);
    }
  }
}

export function buildActionOwnerManifest(
  routeReachability: ActionOwnerRouteReachability,
): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  for (const [pattern, reachability] of routeReachability) {
    for (const actionId of reachability.serverReferenceIds) {
      (manifest[actionId] ??= []).push(pattern);
    }
  }
  return manifest;
}
