import { createHash } from "node:crypto";
import path from "pathslash";
import type { Rollup } from "vite";
import { parseModuleRecord } from "../plugins/ast-utils.js";
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

// The files of one route segment, outermost first, as Next.js nests them.
const SEGMENT_FILE_ORDER = [
  "layout",
  "template",
  "error",
  "loading",
  "not-found",
  "forbidden",
  "unauthorized",
  "default",
  "page",
];

/**
 * Order route files as they render: outer segments first and, within a
 * segment, each file before the ones it wraps. A group evaluates its members in
 * the order the walk reaches them, so this keeps an outer layout's top-level
 * side effects and CSS ahead of its page's, as Next.js evaluates client
 * references in render order.
 */
function inRenderOrder(files: readonly string[]): string[] {
  const rank = (file: string) => {
    const index = SEGMENT_FILE_ORDER.indexOf(path.basename(file).split(".")[0]!);
    return index === -1 ? SEGMENT_FILE_ORDER.length : index;
  };
  return files
    .map((file) => ({ file, depth: path.dirname(file).split("/").length, rank: rank(file) }))
    .sort((a, b) => a.depth - b.depth || a.rank - b.rank)
    .map(({ file }) => file);
}

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
 * order a depth-first walk in import order first reaches each reference from
 * the route files in render order, which follows ES module evaluation order.
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
      inRenderOrder(
        actionOwnerRouteEntryIds({
          ...route,
          parallelSlots: route.parallelSlots.map((slot) => ({ ...slot, interceptingRoutes: [] })),
          siblingIntercepts: [],
        }),
      ),
    );
    const intercepts = [
      ...route.parallelSlots.flatMap((slot) => slot.interceptingRoutes),
      ...route.siblingIntercepts,
    ];
    for (const intercept of intercepts) {
      addOwner(fileOwner(intercept.pagePath), inRenderOrder(interceptEntryIds(intercept)));
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

/** Export names an importer uses from a module, or `"*"` for all of them. */
type UsedNames = ReadonlySet<string> | "*";

type ModuleBindings = {
  /** Transformed source bytes, not counting import and export-list statements. */
  bytes: number;
  /** Static imports, with the names each one uses. */
  imports: ReadonlyArray<{ id: string; names: UsedNames }>;
  /**
   * Re-exports: `export { a as b } from`, `export * from` (`exportName` and
   * `importName` are `"*"`), `export * as ns from` (`importName` is `"*"`), and
   * imported bindings that the module only re-exports.
   */
  reexports: ReadonlyArray<{ id: string; exportName: string; importName: string }>;
};

type LoadedModule = {
  code: string | null;
  importedIds: readonly string[];
  /**
   * Without bindings, every static import of the module counts in full. With
   * them, a side-effect-free module's re-exports only count for the names its
   * importers use, as tree-shaking would keep them.
   */
  bindings?: ModuleBindings;
};

function importedName(kind: string, name: string | null): string {
  if (kind === "Name") return name!;
  return kind === "Default" ? "default" : "*";
}

/**
 * Read a module's static imports and re-exports for
 * {@link measureClientReferenceGroupCosts}. Returns undefined when the code does
 * not parse or a specifier does not resolve to one of `importedIds`.
 */
export async function readClientModuleBindings(options: {
  code: string;
  importedIds: readonly string[];
  resolve: (specifier: string) => Promise<string | null>;
}): Promise<ModuleBindings | undefined> {
  const { code } = options;
  const record = parseModuleRecord(code, "js");
  if (!record) return undefined;
  const specifiers = new Set([
    ...record.staticImports.map((statement) => statement.moduleRequest.value),
    ...record.staticExports.flatMap((statement) =>
      statement.entries.flatMap((entry) =>
        entry.moduleRequest ? [entry.moduleRequest.value] : [],
      ),
    ),
  ]);
  const importedIds = new Set(options.importedIds);
  const ids = new Map<string, string>();
  for (const [specifier, id] of await Promise.all(
    [...specifiers].map(
      async (specifier) => [specifier, await options.resolve(specifier)] as const,
    ),
  )) {
    if (id === null || !importedIds.has(id)) return undefined;
    ids.set(specifier, id);
  }

  // The record lists `import { a } from "./a"; export { a };` as an indirect
  // export entry on the import statement, located at the `a` specifier.
  const isIndirect = (statement: { start: number }) => code.startsWith("import", statement.start);

  // Import statements and `export { … }` / `export * …` lists emit no code of
  // their own. Their removal also shows which imported bindings the rest of
  // the module never references.
  const exportList = /export\s*[{*]/y;
  const ranges = [
    ...record.staticImports,
    ...record.staticExports.filter((statement) => {
      exportList.lastIndex = statement.start;
      return exportList.test(code);
    }),
    ...record.staticExports.filter(isIndirect).flatMap((statement) => statement.entries),
  ].sort((a, b) => a.start - b.start);
  let body = "";
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) body += code.slice(offset, range.start);
    offset = Math.max(offset, range.end);
  }
  body += code.slice(offset);

  const reexports: { id: string; exportName: string; importName: string }[] = [];
  // Export names of local bindings, keyed by local name, or for indirect
  // exports by the position of the imported name in the import statement
  // (their recorded import name is the local name for default imports).
  const localExports = new Map<string, string[]>();
  const addLocalExport = (key: string, exportName: string) =>
    localExports.set(key, [...(localExports.get(key) ?? []), exportName]);
  for (const statement of record.staticExports) {
    for (const entry of statement.entries) {
      const exportName = importedName(entry.exportName.kind, entry.exportName.name);
      const importName = importedName(entry.importName.kind, entry.importName.name);
      if (entry.moduleRequest && isIndirect(statement)) {
        addLocalExport(`\0${entry.importName.start}`, exportName);
      } else if (entry.moduleRequest) {
        reexports.push({ id: ids.get(entry.moduleRequest.value)!, exportName, importName });
      } else if (entry.localName.name !== null) {
        addLocalExport(entry.localName.name, exportName);
      }
    }
  }

  const imports: { id: string; names: UsedNames }[] = [];
  for (const statement of record.staticImports) {
    const id = ids.get(statement.moduleRequest.value)!;
    imports.push({ id, names: new Set() });
    for (const entry of statement.entries) {
      if (entry.isType) continue;
      const name = importedName(entry.importName.kind, entry.importName.name);
      const local = entry.localName.value;
      const exportNames = [
        ...(localExports.get(local) ?? []),
        ...((entry.importName.start !== null && localExports.get(`\0${entry.importName.start}`)) ||
          []),
      ];
      if (
        exportNames.length > 0 &&
        !new RegExp(`(?<![\\w$])${local.replaceAll("$", "\\$")}(?![\\w$])`).test(body)
      ) {
        for (const exportName of exportNames) reexports.push({ id, exportName, importName: name });
      } else {
        imports.push({ id, names: name === "*" ? "*" : new Set([name]) });
      }
    }
  }
  // Count any import the record missed in full.
  const covered = new Set(ids.values());
  for (const id of options.importedIds) if (!covered.has(id)) imports.push({ id, names: "*" });

  return {
    bytes: Buffer.byteLength(body, "utf8"),
    imports,
    reexports,
  };
}

/**
 * Estimate, in transformed source bytes, how much code each client reference
 * would add to a route group's chunk: the modules only it uses, plus the cost
 * of every client reference it statically imports (grouping a reference pulls
 * those along). Modules shared with other client references are not charged
 * to any one of them, so shared libraries do not block grouping. With
 * {@link readClientModuleBindings}, a side-effect-free module only charges the
 * re-exports that are imported from it, so a reference that imports one icon
 * from a barrel is not charged for the whole library.
 *
 * `references` maps each client reference id to its module id in the client
 * graph. `isSideEffectFree` reports a module's package `sideEffects` flag as
 * the bundler resolved it. Traversal stops at modules for which `isExcluded`
 * returns true (CSS, always-loaded framework chunks, virtual modules that must
 * not be loaded re-entrantly). A reference whose import graph cannot be fully
 * loaded is reported as `null` so callers keep it out of groups.
 */
export async function measureClientReferenceGroupCosts(options: {
  references: ReadonlyMap<string, string>;
  loadModule: (id: string) => Promise<LoadedModule>;
  isExcluded: (id: string) => boolean;
  /**
   * Whether a module has no side effects. A side-effect-free module is not
   * loaded until a reference uses one of its exports.
   */
  isSideEffectFree: (id: string) => boolean;
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
  // other client reference, which is recorded as an imported reference. The
  // walk tracks the export names used from each module, so a side-effect-free
  // barrel only charges the re-exports a reference actually imports.
  const moduleBytes = new Map<string, number>();
  const ownModules = new Map<string, Set<string> | null>();
  const importedReferences = new Map<string, Set<string>>();
  await Promise.all(
    [...options.references].map(async ([referenceId, rootModuleId]) => {
      const own = new Set<string>();
      const imported = new Set<string>();
      importedReferences.set(referenceId, imported);
      const used = new Map<string, Set<string> | "*">([[rootModuleId, "*"]]);
      const use = (id: string, names: UsedNames, next: string[]) => {
        if (options.isExcluded(id)) return;
        const importedReference = referenceByModuleId.get(id);
        if (importedReference !== undefined) {
          if (importedReference !== referenceId) imported.add(importedReference);
          return;
        }
        const current = used.get(id);
        if (current === "*") return;
        if (!current && names !== "*" && names.size === 0 && options.isSideEffectFree(id)) return;
        if (names === "*" || !current) {
          used.set(id, names === "*" ? "*" : new Set(names));
          next.push(id);
          return;
        }
        const size = current.size;
        for (const name of names) current.add(name);
        if (current.size > size) next.push(id);
      };
      let frontier = [rootModuleId];
      while (frontier.length > 0) {
        frontier = [...new Set(frontier)];
        const modules = await Promise.all(frontier.map(load));
        const next: string[] = [];
        for (let index = 0; index < modules.length; index++) {
          const module = modules[index];
          if (!module) {
            ownModules.set(referenceId, null);
            return;
          }
          const id = frontier[index]!;
          const names = used.get(id)!;
          const { bindings } = module;
          const treeShaken = names !== "*" && options.isSideEffectFree(id);
          // Tree-shaking drops a side-effect-free module nothing uses.
          if (treeShaken && names.size === 0) continue;
          own.add(id);
          moduleBytes.set(
            id,
            bindings?.bytes ?? (module.code ? Buffer.byteLength(module.code, "utf8") : 0),
          );
          if (!bindings) {
            for (const importedId of module.importedIds) use(importedId, "*", next);
            continue;
          }
          for (const edge of bindings.imports) use(edge.id, edge.names, next);
          for (const edge of bindings.reexports) {
            let reexported: UsedNames;
            if (!treeShaken || (edge.exportName !== "*" && names.has(edge.exportName))) {
              reexported = edge.importName === "*" ? "*" : new Set([edge.importName]);
            } else if (edge.exportName === "*") {
              reexported = new Set([...names].filter((name) => name !== "default"));
            } else {
              // Still reached, so a target with side effects counts.
              reexported = new Set();
            }
            use(edge.id, reexported, next);
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
 * signatures with a single member stay ungrouped. Group keys derive from the
 * members' `referenceKeys`, so a group keeps its chunk name when routes change
 * but its members do not.
 */
export function planClientReferenceGroups(options: {
  referenceIds: ReadonlySet<string>;
  /** Stable, machine-independent key of each client reference. */
  referenceKeys: ReadonlyMap<string, string>;
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
    const memberKeys = members.map((referenceId) => options.referenceKeys.get(referenceId)!);
    const hash = createHash("sha256").update(memberKeys.sort().join("\0")).digest("hex");
    let length = 10;
    while (usedKeys.has(hash.slice(0, length))) length++;
    const key = hash.slice(0, length);
    usedKeys.add(key);
    groups.push({ key, referenceIds: members });
  }
  return groups;
}
