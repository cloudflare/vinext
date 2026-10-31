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

// The files of one route segment, outermost first, as the App Router nests
// them (see `app-page-route-wiring.tsx`).
const SEGMENT_FILE_ORDER = [
  "layout",
  "template",
  "error",
  "unauthorized",
  "forbidden",
  "not-found",
  "loading",
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
    intercept.forbiddenPath,
    intercept.unauthorizedPath,
    ...(intercept.notFoundPaths ?? []),
    ...(intercept.forbiddenPaths ?? []),
    ...(intercept.unauthorizedPaths ?? []),
    ...(intercept.errorPaths ?? []),
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

export type ClientReferencePreloadPlan = {
  /**
   * Client references any render may use: those reached from outside route
   * files (vinext's runtime, server actions), those of `alwaysRoots`
   * (global-error, the root boundaries), and those no walk reaches.
   */
  always: string[];
  /** The client references each route file reaches, through any import. */
  files: string[][];
  /** Each route pattern's files, as indices into `files`. */
  routes: Map<string, number[]>;
  /** The files of a render without a route, as indices into `files`. */
  routeless: number[];
  /**
   * References route files reach only through static imports, outside
   * `always`. A render may stream one whose module evaluates asynchronously
   * instead of waiting for it; a reference any dynamic import reaches, such as
   * a `next/dynamic` component, always loads first.
   */
  staticOnly: string[];
  /** Each route pattern's references whose stylesheets a streaming render links up front. */
  stylesheets: Map<string, string[]>;
};

/**
 * The files that render with a route. Its error and access boundaries stay out:
 * their stylesheets would apply to every page, and a streamed error renders
 * them in the browser, whose loader waits for their stylesheets.
 */
function routeRenderedFileIds(route: ClientReferenceGroupRoute): string[] {
  return [
    route.pagePath,
    ...route.layouts,
    ...route.templates,
    route.loadingPath,
    ...(route.loadingPaths ?? []),
    ...route.parallelSlots.flatMap((slot) => [
      slot.pagePath,
      slot.defaultPath,
      slot.layoutPath,
      ...(slot.configLayoutPaths ?? []),
      slot.loadingPath,
      ...(slot.loadingPaths ?? []),
    ]),
  ].filter((value): value is string => typeof value === "string");
}

/**
 * Plan which client references SSR loads before rendering each route. A route
 * preloads every client reference its page, layouts, templates, boundaries and
 * parallel slots reach, statically or through dynamic imports (a
 * `next/dynamic` component renders on the server), plus the `always` set.
 * Intercepting routes only render on soft navigation, which SSR never
 * renders, so they add to no set. `entryIds` are the RSC graph's entries:
 * walking them up to route files finds what renders outside any route.
 */
export function collectClientReferencePreloadPlan(options: {
  alwaysRoots?: readonly string[];
  canonicalizeModuleId?: (id: string) => string;
  clientReferenceIds: ReadonlySet<string>;
  entryIds: readonly string[];
  getModuleInfo: (id: string) => ModuleGraphInfo | null;
  routelessFiles?: readonly string[];
  routes: readonly ClientReferenceGroupRoute[];
}): ClientReferencePreloadPlan {
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
  const reached = new Set<string>();
  const referencesReachedFrom = (
    roots: readonly string[],
    stopAt?: ReadonlySet<string>,
    followDynamicImports = true,
  ) => {
    const references: string[] = [];
    const visited = new Set<string>();
    const stack = roots.map(canonicalize).reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      // Checked first, so the entry walk leaves route files that are client
      // references themselves (every error.tsx) to their routes' sets.
      if (stopAt?.has(id)) continue;
      if (options.clientReferenceIds.has(id)) {
        references.push(id);
        reached.add(id);
        continue;
      }
      const info = getModuleInfo(id);
      if (!info) continue;
      const imports = followDynamicImports
        ? [...info.importedIds, ...info.dynamicallyImportedIds]
        : info.importedIds;
      for (let index = imports.length - 1; index >= 0; index--) stack.push(imports[index]!);
    }
    return references;
  };

  const files: string[][] = [];
  const fileIndices = new Map<string, number>();
  const fileIndex = (file: string) => {
    const id = canonicalize(file);
    let index = fileIndices.get(id);
    if (index === undefined) {
      index = files.length;
      fileIndices.set(id, index);
      files.push(referencesReachedFrom([id]));
    }
    return index;
  };
  const routes = new Map<string, number[]>();
  const stylesheets = new Map<string, string[]>();
  const interceptFiles: string[] = [];
  for (const route of options.routes) {
    const indices = inRenderOrder(
      actionOwnerRouteEntryIds({
        ...route,
        parallelSlots: route.parallelSlots.map((slot) => ({ ...slot, interceptingRoutes: [] })),
        siblingIntercepts: [],
      }),
    ).map(fileIndex);
    // Patterns are unique, but a duplicate must still preload both routes.
    routes.set(route.pattern, [...new Set([...(routes.get(route.pattern) ?? []), ...indices])]);
    // Static imports only: `next/dynamic` links its own stylesheets.
    stylesheets.set(route.pattern, [
      ...new Set([
        ...(stylesheets.get(route.pattern) ?? []),
        ...referencesReachedFrom(inRenderOrder(routeRenderedFileIds(route)), undefined, false),
      ]),
    ]);
    for (const intercept of [
      ...route.parallelSlots.flatMap((slot) => slot.interceptingRoutes),
      ...route.siblingIntercepts,
    ]) {
      interceptFiles.push(...interceptEntryIds(intercept));
    }
  }
  const routeless = [...new Set((options.routelessFiles ?? []).map(fileIndex))];
  // Only for `reached`: an intercept's references load during its render.
  referencesReachedFrom(interceptFiles);

  const alwaysRoots = options.alwaysRoots ?? [];
  const stopAt = new Set([
    ...fileIndices.keys(),
    ...[...interceptFiles, ...alwaysRoots].map(canonicalize),
  ]);
  const always = new Set([
    ...referencesReachedFrom(options.entryIds, stopAt),
    ...referencesReachedFrom(alwaysRoots),
  ]);
  for (const id of options.clientReferenceIds) if (!reached.has(id)) always.add(id);

  // References any walk reaches through a dynamic import: each module is
  // visited once statically and once behind a dynamic import. As above, the
  // entry walk stops at route files, which the RSC entry imports lazily, and
  // leaves them to their own walks.
  const dynamicallyReached = new Set<string>();
  const visited = new Set<string>();
  const pending: Array<[id: string, dynamic: boolean, root: boolean]> = [
    ...options.entryIds.map(canonicalize),
    ...stopAt,
  ].map((id) => [id, false, true]);
  while (pending.length > 0) {
    const [id, dynamic, root] = pending.pop()!;
    if (!root && stopAt.has(id)) continue;
    const key = dynamic ? `dynamic:${id}` : id;
    if (visited.has(key)) continue;
    visited.add(key);
    if (options.clientReferenceIds.has(id)) {
      if (dynamic) dynamicallyReached.add(id);
      continue;
    }
    const info = getModuleInfo(id);
    if (!info) continue;
    for (const imported of info.importedIds) pending.push([imported, dynamic, false]);
    for (const imported of info.dynamicallyImportedIds) pending.push([imported, true, false]);
  }
  const staticOnly = [...new Set(files.flat())].filter(
    (id) => !always.has(id) && !dynamicallyReached.has(id),
  );
  return { always: [...always], files, routes, routeless, staticOnly, stylesheets };
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

  // A tree-shaken module only follows the re-exports its importers use, so
  // index them by export name. A barrel then costs each reference the names it
  // imports, not its whole export list. Re-exports nobody uses still keep
  // targets with side effects. Every target has resolved by the time the
  // module's bindings are read, so its side-effect flag is known here.
  type Reexport = ModuleBindings["reexports"][number];
  type ReexportIndex = {
    byName: Map<string, Reexport[]>;
    stars: Reexport[];
    sideEffectTargets: Set<string>;
  };
  const reexportIndexes = new Map<string, ReexportIndex>();
  const indexReexports = (id: string, bindings: ModuleBindings) => {
    let index = reexportIndexes.get(id);
    if (index) return index;
    index = { byName: new Map(), stars: [], sideEffectTargets: new Set() };
    for (const edge of bindings.reexports) {
      if (edge.exportName === "*") {
        index.stars.push(edge);
        continue;
      }
      const edges = index.byName.get(edge.exportName);
      if (edges) edges.push(edge);
      else index.byName.set(edge.exportName, [edge]);
      if (!options.isSideEffectFree(edge.id)) index.sideEffectTargets.add(edge.id);
    }
    reexportIndexes.set(id, index);
    return index;
  };
  const noNames: ReadonlySet<string> = new Set();
  const importedNames = (edge: { importName: string }): UsedNames =>
    edge.importName === "*" ? "*" : new Set([edge.importName]);

  // Each reference uses its static graph up to (not including) any other client
  // reference, which is recorded as an imported reference. The walk tracks the
  // export names used from each module, so a side-effect-free barrel only
  // charges the re-exports a reference actually imports. Its nodes are slots: a
  // module used as a whole (`"*"`), or one export name of a tree-shaken module.
  // What a slot reaches does not depend on which reference reached it, so all
  // references share one walk over the slots instead of each walking the
  // libraries they share.
  type Slot = {
    id: string;
    name: string;
    children: Slot[];
    references: string[];
    failed: boolean;
  };
  const slots = new Map<string, Slot>();
  const moduleBytes = new Map<string, number>();
  let frontier: Slot[] = [];
  const slot = (id: string, name: string) => {
    const key = `${name}\0${id}`;
    let found = slots.get(key);
    if (!found) {
      found = { id, name, children: [], references: [], failed: false };
      slots.set(key, found);
      frontier.push(found);
    }
    return found;
  };
  const link = (from: Slot, id: string, names: UsedNames) => {
    if (options.isExcluded(id)) return;
    const reference = referenceByModuleId.get(id);
    if (reference !== undefined) {
      from.references.push(reference);
    } else if (names === "*" || !options.isSideEffectFree(id)) {
      from.children.push(slot(id, "*"));
    } else {
      // Tree-shaking drops a side-effect-free module nothing uses.
      for (const name of names) from.children.push(slot(id, name));
    }
  };
  const rootSlots = new Map<string, Slot>();
  for (const [referenceId, rootModuleId] of options.references) {
    rootSlots.set(referenceId, slot(rootModuleId, "*"));
  }
  while (frontier.length > 0) {
    const current = frontier;
    frontier = [];
    const modules = await Promise.all(current.map((from) => load(from.id)));
    for (let index = 0; index < modules.length; index++) {
      const module = modules[index];
      const from = current[index]!;
      if (!module) {
        from.failed = true;
        continue;
      }
      const { bindings } = module;
      moduleBytes.set(
        from.id,
        bindings?.bytes ?? (module.code ? Buffer.byteLength(module.code, "utf8") : 0),
      );
      if (!bindings) {
        for (const importedId of module.importedIds) link(from, importedId, "*");
        continue;
      }
      for (const edge of bindings.imports) link(from, edge.id, edge.names);
      if (from.name === "*") {
        for (const edge of bindings.reexports) link(from, edge.id, importedNames(edge));
        continue;
      }
      const reexports = indexReexports(from.id, bindings);
      for (const edge of reexports.byName.get(from.name) ?? []) {
        link(from, edge.id, importedNames(edge));
      }
      // `export *` never re-exports `default`, but its targets are still reached.
      const starNames = from.name === "default" ? noNames : new Set([from.name]);
      for (const edge of reexports.stars) link(from, edge.id, starNames);
      // Still reached, so a target with side effects counts.
      for (const target of reexports.sideEffectTargets) link(from, target, noNames);
    }
  }

  // Imported references and modules that failed to load can sit below shared
  // modules, so walk each reference's graph for them, but only through slots
  // that lead to one.
  const parents = new Map<Slot, Slot[]>();
  const leads = new Set<Slot>();
  for (const from of slots.values()) {
    for (const child of from.children) {
      let childParents = parents.get(child);
      if (!childParents) {
        childParents = [];
        parents.set(child, childParents);
      }
      childParents.push(from);
    }
    if (from.references.length > 0 || from.failed) leads.add(from);
  }
  for (const lead of leads) {
    for (const parent of parents.get(lead) ?? []) leads.add(parent);
  }
  const importedReferences = new Map<string, Set<string>>();
  const unloadable = new Set<string>();
  for (const [referenceId, root] of rootSlots) {
    const imported = new Set<string>();
    importedReferences.set(referenceId, imported);
    if (!leads.has(root)) continue;
    const visited = new Set([root]);
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.failed) unloadable.add(referenceId);
      for (const reference of current.references) {
        if (reference !== referenceId) imported.add(reference);
      }
      for (const child of current.children) {
        if (leads.has(child) && !visited.has(child)) {
          visited.add(child);
          stack.push(child);
        }
      }
    }
  }

  // Mark each slot with the one reference that reaches it, or `null` once a
  // second one does. A slot's mark changes at most twice, so this is linear in
  // the size of the graph however many references share it.
  const slotOwners = new Map<Slot, string | null>();
  const marks: Array<[Slot, string | null]> = [];
  for (const [referenceId, root] of rootSlots) {
    // A reference whose graph did not fully load has no estimate, so modules it
    // reaches still count toward the one other reference that uses them.
    if (!unloadable.has(referenceId)) marks.push([root, referenceId]);
  }
  while (marks.length > 0) {
    const [marked, owner] = marks.pop()!;
    const current = slotOwners.get(marked);
    const next = current === undefined || current === owner ? owner : null;
    if (next === current) continue;
    slotOwners.set(marked, next);
    for (const child of marked.children) marks.push([child, next]);
  }
  const moduleOwners = new Map<string, string | null>();
  for (const [marked, owner] of slotOwners) {
    const current = moduleOwners.get(marked.id);
    moduleOwners.set(marked.id, current === undefined || current === owner ? owner : null);
  }
  const exclusiveBytes = new Map<string, number>();
  for (const [moduleId, owner] of moduleOwners) {
    if (owner === null) continue;
    exclusiveBytes.set(owner, (exclusiveBytes.get(owner) ?? 0) + (moduleBytes.get(moduleId) ?? 0));
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
      cost = unloadable.has(current) ? null : cost + (exclusiveBytes.get(current) ?? 0);
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
