import path from "pathslash";
import type { Rollup } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";
import { actionOwnerRouteEntryIds } from "./action-owner-manifest.js";

type FontOwnerRoute = Parameters<typeof actionOwnerRouteEntryIds>[0];

type ModuleGraphInfo = Pick<Rollup.ModuleInfo, "dynamicallyImportedIds" | "importedIds">;

/**
 * Which fonts each App Router render carries. A font is owned by the module
 * that calls its loader (see `vinext:font-owner` in `plugins/fonts.ts`), and a
 * render carries the fonts of the owners its files reach. Mirrors Next.js'
 * `next-font-manifest`, which lists each app entry's fonts.
 */
export type FontOwnerManifest = {
  /** Owner keys of each route's documents, by route pattern. A route that is missing has none. */
  routes: Record<string, string[]>;
  /** Owner keys of a render without a matched route, such as a route-miss 404. */
  routeless: string[];
  /**
   * The server-module owners whose font rules each route's RSC payload carries
   * for a client navigation, by route pattern: the route's own, and those of
   * the intercepting routes it renders for a soft navigation. Client
   * components load their fonts in the browser themselves, so they are left
   * out. A route that is missing has none.
   */
  navigation: Record<string, FontNavigationOwners>;
  /**
   * Owner keys of the standalone `app/global-not-found` render of a route-miss
   * 404, which skips the root layouts (Next.js' `/_global-not-found` entry).
   */
  globalNotFound: string[];
};

type FontNavigationOwners = { route?: string[]; intercepts?: string[] };

/** The key a font owner module is recorded under: its path relative to the root. */
export function fontOwnerKey(root: string, id: string): string {
  return path.relative(root, stripViteModuleQuery(id));
}

/**
 * The files of a route's own document render: its page, layouts, templates,
 * boundaries and parallel slots. A slot renders its page in its layout, or,
 * when it has no page, its default without that layout. Intercepting routes are left out. They render only on
 * a soft navigation, as entries of their own in Next.js.
 */
export function fontRouteFiles(route: FontOwnerRoute): string[] {
  return actionOwnerRouteEntryIds({
    ...route,
    parallelSlots: route.parallelSlots.map((slot) => ({
      ...slot,
      defaultPath: slot.pagePath ? null : slot.defaultPath,
      // The renderer wraps only a slot's page in its layout, not its default.
      layoutPath: slot.pagePath ? slot.layoutPath : null,
      interceptingRoutes: [],
    })),
    siblingIntercepts: [],
  });
}

/** The files of the intercepting routes a route renders for a soft navigation. */
export function fontInterceptFiles(route: FontOwnerRoute): string[] {
  const own = new Set(fontRouteFiles(route));
  return actionOwnerRouteEntryIds(route).filter((file) => !own.has(file));
}

/** Each module of a build's graph with the modules it imports, statically or dynamically. */
export type ModuleGraphSnapshot = ReadonlyMap<string, readonly string[]>;

export function snapshotModuleGraph(
  ids: Iterable<string>,
  getModuleInfo: (id: string) => ModuleGraphInfo | null,
): ModuleGraphSnapshot {
  const graph = new Map<string, readonly string[]>();
  for (const id of ids) {
    const info = getModuleInfo(id);
    if (info) graph.set(id, [...info.importedIds, ...info.dynamicallyImportedIds]);
  }
  return graph;
}

function importersOf(graph: ModuleGraphSnapshot): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [importer, imported] of graph) {
    for (const id of imported) {
      let list = importers.get(id);
      if (!list) importers.set(id, (list = []));
      list.push(importer);
    }
  }
  return importers;
}

/**
 * The modules that reach `target` through imports, `target` included. A
 * boundary module is reached but its imports are not walked, so nothing above
 * it reaches `target` through it.
 */
function modulesReaching(
  importers: ReadonlyMap<string, readonly string[]>,
  target: string,
  isBoundary: (id: string) => boolean = () => false,
): Set<string> {
  const reached = new Set([target]);
  const stack = [target];
  while (stack.length > 0) {
    for (const importer of importers.get(stack.pop()!) ?? []) {
      if (reached.has(importer) || isBoundary(importer)) continue;
      reached.add(importer);
      stack.push(importer);
    }
  }
  return reached;
}

/**
 * Build the route font manifest from a build's RSC and SSR graphs. Each owner
 * is walked up to the route files that import it, so the cost follows the
 * number of modules that load fonts, not the number of routes. A client
 * reference reaches the owners its SSR graph imports.
 */
export function buildFontOwnerManifest(options: {
  rsc: ModuleGraphSnapshot;
  ssr: ModuleGraphSnapshot;
  /** RSC client reference module ids, with the SSR module each resolves to. */
  clientReferences: ReadonlyMap<string, string>;
  isOwner: (id: string) => boolean;
  ownerKey: (id: string) => string;
  /**
   * The canonical root files of each route's documents, and of the
   * intercepting routes it renders, by route pattern.
   */
  routes: ReadonlyMap<string, { files: readonly string[]; interceptFiles: readonly string[] }>;
  routelessFiles: readonly string[];
  globalNotFoundFiles: readonly string[];
}): FontOwnerManifest {
  // The owner keys each RSC module brings in: its own (a server owner), or,
  // for a client reference, those its SSR graph reaches.
  const ownersByRscModule = new Map<string, Set<string>>();
  const serverOwnersByRscModule = new Map<string, Set<string>>();
  const addOwner = (owners: Map<string, Set<string>>, id: string, key: string) => {
    let keys = owners.get(id);
    if (!keys) owners.set(id, (keys = new Set()));
    keys.add(key);
  };

  const referencesBySsrModule = new Map<string, string[]>();
  for (const [rscId, ssrId] of options.clientReferences) {
    let references = referencesBySsrModule.get(ssrId);
    if (!references) referencesBySsrModule.set(ssrId, (references = []));
    references.push(rscId);
  }
  const ssrImporters = importersOf(options.ssr);
  for (const id of options.ssr.keys()) {
    if (!options.isOwner(id)) continue;
    const key = options.ownerKey(id);
    for (const reaching of modulesReaching(ssrImporters, id)) {
      for (const reference of referencesBySsrModule.get(reaching) ?? []) {
        addOwner(ownersByRscModule, reference, key);
      }
    }
  }
  // A client reference's RSC module is a proxy: its fonts load in the SSR graph.
  for (const id of options.rsc.keys()) {
    if (options.isOwner(id) && !options.clientReferences.has(id)) {
      const key = options.ownerKey(id);
      addOwner(ownersByRscModule, id, key);
      addOwner(serverOwnersByRscModule, id, key);
    }
  }

  const rootFiles = new Set([
    ...[...options.routes.values()].flatMap(({ files, interceptFiles }) => [
      ...files,
      ...interceptFiles,
    ]),
    ...options.routelessFiles,
    ...options.globalNotFoundFiles,
  ]);
  const rscImporters = importersOf(options.rsc);
  const isClientReference = (id: string) => options.clientReferences.has(id);
  const reachingRoots = new Map<string, string[]>();
  const rootsReaching = (id: string) => {
    let roots = reachingRoots.get(id);
    if (!roots) {
      roots = [...modulesReaching(rscImporters, id, isClientReference)].filter((reaching) =>
        rootFiles.has(reaching),
      );
      reachingRoots.set(id, roots);
    }
    return roots;
  };
  const ownersByFile = (ownersByModule: ReadonlyMap<string, ReadonlySet<string>>) => {
    const byFile = new Map<string, Set<string>>();
    for (const [id, keys] of ownersByModule) {
      for (const root of rootsReaching(id)) {
        for (const key of keys) addOwner(byFile, root, key);
      }
    }
    return (files: readonly string[]) =>
      [...new Set(files.flatMap((file) => [...(byFile.get(file) ?? [])]))].sort();
  };
  const ownersOf = ownersByFile(ownersByRscModule);
  const serverOwnersOf = ownersByFile(serverOwnersByRscModule);

  const manifest: FontOwnerManifest = {
    routes: {},
    routeless: ownersOf(options.routelessFiles),
    globalNotFound: ownersOf(options.globalNotFoundFiles),
    navigation: {},
  };
  // Most routes load no font of their own; leave them out.
  for (const [pattern, { files, interceptFiles }] of options.routes) {
    const owners = ownersOf(files);
    if (owners.length > 0) manifest.routes[pattern] = owners;
    const navigation: FontNavigationOwners = {};
    const routeOwners = serverOwnersOf(files);
    const interceptOwners = serverOwnersOf(interceptFiles);
    if (routeOwners.length > 0) navigation.route = routeOwners;
    if (interceptOwners.length > 0) navigation.intercepts = interceptOwners;
    if (navigation.route || navigation.intercepts) manifest.navigation[pattern] = navigation;
  }
  return manifest;
}
