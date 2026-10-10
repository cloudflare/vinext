import { createHash } from "node:crypto";
import path from "pathslash";
import type { Rollup } from "vite";
import { actionOwnerRouteEntryIds } from "./action-owner-manifest.js";

/**
 * Client references whose estimated group cost (see
 * {@link measureClientReferenceGroupCosts}) is larger than this many
 * transformed source bytes keep their own lazy chunk instead of joining a route
 * group. Grouping makes every member load with the group, so a heavy component
 * that a route can reach but rarely renders must not be pulled into that
 * route's startup bundle.
 */
export const CLIENT_REFERENCE_GROUP_MAX_COST_BYTES = 100 * 1024;

type ClientReferenceGroupRoute = Parameters<typeof actionOwnerRouteEntryIds>[0];

type ClientReferenceGroupIntercept = ClientReferenceGroupRoute["siblingIntercepts"][number];

type ModuleGraphInfo = Pick<Rollup.ModuleInfo, "dynamicallyImportedIds" | "importedIds">;

function interceptEntryIds(intercept: ClientReferenceGroupIntercept): string[] {
  return [
    intercept.pagePath,
    ...intercept.layoutPaths,
    ...(intercept.loadingPaths ?? []),
    intercept.notFoundPath,
  ].filter((value): value is string => typeof value === "string");
}

/**
 * Map each client reference reachable from App Router route files to a
 * signature naming the owners that reach it. A route owns its page, layouts,
 * templates, boundaries and parallel slots, which render with it. Intercepting
 * routes (which only render on soft navigation), global-error and
 * global-not-found render on their own, so each is owned by its file, named by
 * its path relative to `root`. References with the same signature are needed
 * together, mirroring Next.js' per-route client entries. The map is in the
 * order a depth-first walk in import order first reaches each reference, which
 * follows ES module evaluation order.
 *
 * References reachable from no route file (for example vinext's internal
 * runtime references) are omitted and keep their own lazy chunk. So are
 * references that route code reaches through a dynamic import (`next/dynamic`,
 * `React.lazy`), directly or through the dynamically imported module's graph.
 */
export function collectClientReferenceRouteSignatures(options: {
  canonicalizeModuleId?: (id: string) => string;
  clientReferenceIds: ReadonlySet<string>;
  getModuleInfo: (id: string) => ModuleGraphInfo | null;
  root: string;
  routes: readonly ClientReferenceGroupRoute[];
  sharedRoots?: readonly string[];
}): Map<string, string> {
  const canonicalize = options.canonicalizeModuleId ?? ((id: string) => id);
  const moduleInfoCache = new Map<string, ModuleGraphInfo | null>();
  const getModuleInfo = (id: string) => {
    let info = moduleInfoCache.get(id);
    if (info === undefined) {
      info = options.getModuleInfo(id);
      moduleInfoCache.set(id, info);
    }
    return info;
  };

  // Client references below a dynamic import (`next/dynamic`, `React.lazy`)
  // load lazily. Grouping would make them eager, and their preloads are looked
  // up by their own module id among the client build's dynamic imports.
  const lazyReferences = new Set<string>();
  const lazyVisited = new Set<string>();
  const markLazy = (root: string) => {
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (lazyVisited.has(id)) continue;
      lazyVisited.add(id);
      if (options.clientReferenceIds.has(id)) {
        lazyReferences.add(id);
        continue;
      }
      const info = getModuleInfo(id);
      if (info) stack.push(...info.importedIds, ...info.dynamicallyImportedIds);
    }
  };

  // Layouts and boundaries are shared by many routes, so walk each route file's
  // graph once and reuse it for every route that includes it.
  const referencesByFile = new Map<string, Set<string>>();
  const referencesReachedFrom = (file: string) => {
    let references = referencesByFile.get(file);
    if (references) return references;
    references = new Set();
    const visited = new Set<string>();
    const stack = [canonicalize(file)];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (options.clientReferenceIds.has(id)) {
        references.add(id);
        continue;
      }
      const info = getModuleInfo(id);
      if (!info) continue;
      for (const importedId of info.dynamicallyImportedIds) markLazy(importedId);
      for (let index = info.importedIds.length - 1; index >= 0; index--) {
        stack.push(info.importedIds[index]!);
      }
    }
    referencesByFile.set(file, references);
    return references;
  };

  const owners = new Map<string, Set<string>>();
  const addOwner = (owner: string, files: readonly string[]) => {
    for (const file of files) {
      for (const reference of referencesReachedFrom(file)) {
        let referenceOwners = owners.get(reference);
        if (!referenceOwners) {
          referenceOwners = new Set();
          owners.set(reference, referenceOwners);
        }
        referenceOwners.add(owner);
      }
    }
  };
  const fileOwner = (file: string) => path.relative(options.root, file);
  for (const route of options.routes) {
    addOwner(
      route.pattern,
      actionOwnerRouteEntryIds({
        ...route,
        parallelSlots: route.parallelSlots.map((slot) => ({ ...slot, interceptingRoutes: [] })),
        siblingIntercepts: [],
      }),
    );
    const intercepts = [
      ...route.parallelSlots.flatMap((slot) => slot.interceptingRoutes),
      ...route.siblingIntercepts,
    ];
    for (const intercept of intercepts) {
      addOwner(fileOwner(intercept.pagePath), interceptEntryIds(intercept));
    }
  }
  for (const file of options.sharedRoots ?? []) addOwner(fileOwner(file), [file]);

  const signatures = new Map<string, string>();
  for (const [reference, referenceOwners] of owners) {
    if (lazyReferences.has(reference)) continue;
    signatures.set(reference, [...referenceOwners].sort().join("\n"));
  }
  return signatures;
}

type LoadedModule = { code: string | null; importedIds: readonly string[] };

/**
 * Estimate, in transformed source bytes, how much code each client reference
 * would add to a route group's chunk: the modules only it uses, plus the cost
 * of every client reference it statically imports (grouping a reference pulls
 * those along). Modules shared with other client references are not charged
 * to any one of them, so shared libraries do not block grouping.
 *
 * `references` maps each client reference id to its module id in the client
 * graph. Traversal stops at modules for which `isExcluded` returns true (CSS,
 * always-loaded framework chunks, virtual modules that must not be loaded
 * re-entrantly). A reference whose import graph cannot be fully loaded is
 * reported as `null` so callers keep it out of groups.
 */
export async function measureClientReferenceGroupCosts(options: {
  references: ReadonlyMap<string, string>;
  loadModule: (id: string) => Promise<LoadedModule>;
  isExcluded: (id: string) => boolean;
}): Promise<Map<string, number | null>> {
  const loaded = new Map<string, Promise<LoadedModule | null>>();
  const load = (id: string) => {
    let module = loaded.get(id);
    if (!module) {
      module = options.loadModule(id).catch(() => null);
      loaded.set(id, module);
    }
    return module;
  };
  const referenceByModuleId = new Map<string, string>();
  for (const [referenceId, moduleId] of options.references) {
    referenceByModuleId.set(moduleId, referenceId);
  }

  // Each reference's own modules: its static graph up to (not including) any
  // other client reference, which is recorded as an imported reference.
  const moduleBytes = new Map<string, number>();
  const ownModules = new Map<string, Set<string> | null>();
  const importedReferences = new Map<string, Set<string>>();
  await Promise.all(
    [...options.references].map(async ([referenceId, rootModuleId]) => {
      const own = new Set<string>([rootModuleId]);
      const imported = new Set<string>();
      importedReferences.set(referenceId, imported);
      let frontier = [rootModuleId];
      while (frontier.length > 0) {
        const modules = await Promise.all(frontier.map(load));
        const next: string[] = [];
        for (let index = 0; index < modules.length; index++) {
          const module = modules[index];
          if (!module) {
            ownModules.set(referenceId, null);
            return;
          }
          moduleBytes.set(
            frontier[index]!,
            module.code ? Buffer.byteLength(module.code, "utf8") : 0,
          );
          for (const importedId of module.importedIds) {
            if (own.has(importedId) || options.isExcluded(importedId)) continue;
            const importedReference = referenceByModuleId.get(importedId);
            if (importedReference !== undefined) {
              if (importedReference !== referenceId) imported.add(importedReference);
              continue;
            }
            own.add(importedId);
            next.push(importedId);
          }
        }
        frontier = next;
      }
      ownModules.set(referenceId, own);
    }),
  );

  const ownerCounts = new Map<string, number>();
  for (const own of ownModules.values()) {
    for (const moduleId of own ?? []) {
      ownerCounts.set(moduleId, (ownerCounts.get(moduleId) ?? 0) + 1);
    }
  }
  const exclusiveBytes = new Map<string, number | null>();
  for (const [referenceId, own] of ownModules) {
    if (!own) {
      exclusiveBytes.set(referenceId, null);
      continue;
    }
    let bytes = 0;
    for (const moduleId of own) {
      if (ownerCounts.get(moduleId) === 1) bytes += moduleBytes.get(moduleId) ?? 0;
    }
    exclusiveBytes.set(referenceId, bytes);
  }

  const costs = new Map<string, number | null>();
  for (const referenceId of options.references.keys()) {
    let cost: number | null = 0;
    const visited = new Set<string>();
    const queue = [referenceId];
    for (let index = 0; index < queue.length && cost !== null; index++) {
      const current = queue[index]!;
      if (visited.has(current)) continue;
      visited.add(current);
      const bytes = exclusiveBytes.get(current);
      cost = bytes == null ? null : cost + bytes;
      for (const importedReference of importedReferences.get(current) ?? []) {
        queue.push(importedReference);
      }
    }
    costs.set(referenceId, cost);
  }
  return costs;
}

export type ClientReferenceGroup = {
  /** Stable, filename-safe identifier derived from the route signature. */
  key: string;
  /**
   * Member client reference ids in signature (route walk) order, which sets
   * module evaluation and CSS order inside the group chunk.
   */
  referenceIds: string[];
};

/**
 * Group client references that share a route signature. References without a
 * signature, references whose cost is unknown or above `maxCostBytes`, and
 * signatures with a single member stay ungrouped.
 */
export function planClientReferenceGroups(options: {
  referenceIds: ReadonlySet<string>;
  signatures: ReadonlyMap<string, string>;
  costs: ReadonlyMap<string, number | null>;
  maxCostBytes: number;
}): ClientReferenceGroup[] {
  const membersBySignature = new Map<string, string[]>();
  for (const [referenceId, signature] of options.signatures) {
    if (!options.referenceIds.has(referenceId)) continue;
    const cost = options.costs.get(referenceId);
    if (cost == null || cost > options.maxCostBytes) continue;
    let members = membersBySignature.get(signature);
    if (!members) {
      members = [];
      membersBySignature.set(signature, members);
    }
    members.push(referenceId);
  }

  const groups: ClientReferenceGroup[] = [];
  const usedKeys = new Set<string>();
  for (const signature of [...membersBySignature.keys()].sort()) {
    const members = membersBySignature.get(signature)!;
    if (members.length < 2) continue;
    const hash = createHash("sha256").update(signature).digest("hex");
    let length = 10;
    while (usedKeys.has(hash.slice(0, length))) length++;
    const key = hash.slice(0, length);
    usedKeys.add(key);
    groups.push({ key, referenceIds: members });
  }
  return groups;
}
