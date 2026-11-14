import { randomBytes } from "node:crypto";
import fs from "node:fs";
import MagicString from "magic-string";
import path from "pathslash";
import { isCSSRequest, type Plugin, type Rollup } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import {
  CLIENT_REFERENCE_GROUP_MAX_COST_BYTES,
  collectClientReferencePreloadPlan,
  collectClientReferenceRouteSignatures,
  measureClientReferenceGroupCosts,
  planClientReferenceGroups,
  readClientModuleBindings,
  type ClientReferencePreloadPlan,
} from "../build/client-reference-groups.js";
import {
  collectAsyncModules,
  createSideEffectsDeclarationCheck,
} from "../build/client-reference-async.js";
import {
  hasUserClientChunkGroups,
  RESOLVED_EAGER_CLIENT_REFERENCES_ID,
} from "../build/client-build-config.js";
import { resolveShimRuntimeModule } from "../entries/runtime-entry-module.js";
import type { AppRoute } from "../routing/app-route-graph.js";
import { magicStringTransformResult, omitUnusedBuildSourcemap } from "./transform-result.js";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RESOLVED_ID_PROXY_PREFIX = "virtual:vite-rsc/resolved-id/";
const CLIENT_REFERENCE_GROUP_PREFIX = "virtual:vinext-client-reference-group-";
const RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX = `\0${CLIENT_REFERENCE_GROUP_PREFIX}`;
// A client reference outside every group registers through its own module.
// The id ends with the reference's file name, which names its chunk.
const CLIENT_REFERENCE_MODULE_PREFIX = "virtual:vinext-client-reference-module/";
/** Prefixes the module that registers one client reference outside every group. */
export const RESOLVED_CLIENT_REFERENCE_MODULE_PREFIX = `\0${CLIENT_REFERENCE_MODULE_PREFIX}`;
const CLIENT_REFERENCES_ID_RE = /^\0virtual:vite-rsc\/client-references$/;
const CLIENT_REFERENCE_MODULE_RE =
  /^virtual:vinext-client-reference-(?:group-|module\/)|^virtual:vinext-client-reference-(?:chunks|eager)$/;
const RESOLVED_CLIENT_REFERENCE_MODULE_RE =
  /^\0virtual:vinext-client-reference-(?:group-|module\/)|^\0virtual:vinext-client-reference-(?:chunks|eager)$/;
const CLIENT_REFERENCE_CHUNKS_ID = "virtual:vinext-client-reference-chunks";
export const RESOLVED_CLIENT_REFERENCE_CHUNKS_ID = `\0${CLIENT_REFERENCE_CHUNKS_ID}`;

// A null plan makes the App Router SSR entry preload every client reference.
const NO_ROUTE_CLIENT_REFERENCES_EXPORT = "export const routeClientReferences = null;\n";

type RscClientReferenceMeta = PluginApi["manager"]["clientReferenceMetaMap"][string];

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

export type RscClientReferenceRouteOptions = {
  /** Maps route file paths to the module ids used by the RSC module graph. */
  canonicalizeModuleId: (id: string) => string;
  /** App Router routes of the current build, or null outside App Router builds. */
  getRoutes: () => readonly AppRoute[] | null;
  /**
   * Files any route's render can show: global-error, and the root boundaries
   * that routes without their own not-found, forbidden or unauthorized use.
   */
  getAlwaysRenderedFiles: () => readonly string[];
  /**
   * The files a render without a route (a route-miss 404) shows: the root
   * layouts and boundaries, and global-not-found.
   */
  getRoutelessFiles: () => readonly string[];
  /** Route-independent roots such as global-error and global-not-found. */
  getSharedRoots: () => readonly string[];
};

export type RscClientReferenceGroupingOptions = {
  /** Modules that live in chunks every page loads anyway (React, vinext runtime). */
  isAlwaysLoadedClientModule: (id: string) => boolean;
  /** vinext's own client chunk groups. Any other chunk group disables grouping. */
  ownClientChunkGroups: ReadonlySet<unknown>;
};

/**
 * Whether the cost estimate loads a module. Rolldown keeps externals and
 * unresolved `require()`s in `importedIds` under their specifier (a bare name
 * or URL), and never settles a load of one, so only files and `\0` virtual
 * modules are measured.
 */
function isMeasured(id: string): boolean {
  return id.startsWith("\0") || path.isAbsolute(id);
}

type PackageMetadata = Pick<Rollup.ResolvedId, "moduleSideEffects" | "packageJsonPath">;

/**
 * Whether `id` shares the package `sideEffects` flag of `owner`: it is in the
 * same package, and the package's `sideEffects` field is not a list of files.
 * `uniformSideEffects` caches that last check per package.json path.
 */
function isInPackage(
  id: string,
  owner: PackageMetadata,
  uniformSideEffects: Map<string, boolean>,
): boolean {
  const packageJsonPath = owner.packageJsonPath;
  if (!packageJsonPath) return false;
  const relative = path.relative(path.dirname(packageJsonPath), id);
  if (relative.startsWith("..") || relative.split("/").includes("node_modules")) return false;
  let uniform = uniformSideEffects.get(packageJsonPath);
  if (uniform === undefined) {
    try {
      const { sideEffects } = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      uniform = sideEffects === undefined || typeof sideEffects === "boolean";
    } catch {
      uniform = false;
    }
    uniformSideEffects.set(packageJsonPath, uniform);
  }
  return uniform;
}

function withResolvedIdProxy(resolvedId: string): string {
  return resolvedId.startsWith("\0")
    ? RESOLVED_ID_PROXY_PREFIX + encodeURIComponent(resolvedId)
    : resolvedId;
}

function sortedRenderedExports(meta: RscClientReferenceMeta): string[] {
  return meta.renderedExports.slice().sort();
}

/**
 * The exports of a client reference, read from the module namespace `binding`.
 * Keep them lazy. In async or cyclic client module evaluation, eagerly copying
 * module namespace values can observe an uninitialized binding.
 */
function generateClientReferenceObject(meta: RscClientReferenceMeta, binding: string): string {
  const exports = sortedRenderedExports(meta)
    .map(
      (name) => `  get ${JSON.stringify(name)}() { return ${binding}[${JSON.stringify(name)}]; },`,
    )
    .join("\n");
  return exports ? `{\n${exports}\n}` : "{}";
}

function generateClientReferenceLoaders(metas: RscClientReferenceMeta[]): string {
  const entries = metas
    .slice()
    .sort((a, b) => a.referenceKey.localeCompare(b.referenceKey))
    .map((meta) =>
      [
        `${JSON.stringify(meta.referenceKey)}: async () => {`,
        `  const m = await import(${JSON.stringify(withResolvedIdProxy(meta.importId))});`,
        `  return ${generateClientReferenceObject(meta, "m")};`,
        `},`,
      ].join("\n"),
    )
    .join("\n");

  return `export default {\n${entries}\n};\n`;
}

/**
 * The client build's client-references module, which the App browser entry
 * imports. It names no client reference chunk, so the entry neither grows nor
 * changes its hash with the app's client references: each reference's Flight
 * row names the chunks it loads (see shims/internal/client-reference-loader.ts).
 */
function generateBrowserClientReferencesModule(loaderPath: string, eager: boolean): string {
  const eagerImport = eager
    ? `import ${JSON.stringify(RESOLVED_EAGER_CLIENT_REFERENCES_ID.slice(1))};\n`
    : "";
  return `${eagerImport}export { clientReferences as default } from ${JSON.stringify(loaderPath)};\n`;
}

/**
 * A client build module that registers client references as it evaluates:
 * a route group's members, the references in chunks every page loads, or one
 * other reference outside every group. It imports
 * only each member's rendered exports, so unused exports and their
 * dependencies still tree-shake as they do with direct loaders. A member
 * without rendered exports is imported for its side effects. The last member
 * is imported last (see build/client-reference-chunks.ts).
 */
function generateClientReferenceModule(
  metas: readonly RscClientReferenceMeta[],
  loaderPath: string,
): string {
  const imports = metas.map((meta, index) => {
    const source = JSON.stringify(withResolvedIdProxy(meta.importId));
    return meta.renderedExports.length > 0
      ? `import * as m${index} from ${source};`
      : `import ${source};`;
  });
  const registrations = metas.map(
    (meta, index) =>
      `registerClientReference(${JSON.stringify(meta.referenceKey)}, ${generateClientReferenceObject(meta, `m${index}`)});`,
  );
  return [
    `import { registerClientReference } from ${JSON.stringify(loaderPath)};`,
    ...imports,
    ...registrations,
    "",
  ].join("\n");
}

/**
 * The browser never loads this module. Its dynamic imports make each client
 * reference module a chunk of its own that only a Flight row names.
 */
function generateClientReferenceChunksModule(moduleIds: readonly string[]): string {
  const imports = moduleIds.map((id) => `  () => import(${JSON.stringify(id.slice(1))}),`);
  return `export default [\n${imports.join("\n")}\n];\n`;
}

/** A reference the SSR plan may stream, by its index in `references`. */
type AsyncReferenceCandidate = { index: number; importId: string };

/**
 * The SSR build's `routeClientReferences` export: the reference keys each route
 * preloads before it renders (see server/app-client-reference-preloader.ts),
 * stored as indices into `references`. Client references the plan doesn't know
 * join `always`. `async` holds `asyncPlaceholder`, which renderChunk replaces
 * with the candidates whose SSR modules evaluate asynchronously.
 */
function generateRouteClientReferencesExport(
  plan: { referenceIds: ReadonlySet<string>; preloads: ClientReferencePreloadPlan } | null,
  metaEntries: readonly (readonly [string, RscClientReferenceMeta])[],
  asyncPlaceholder: string,
): { code: string; asyncCandidates: AsyncReferenceCandidate[] } {
  if (!plan) return { code: NO_ROUTE_CLIENT_REFERENCES_EXPORT, asyncCandidates: [] };
  const metaById = new Map(metaEntries);
  const references: string[] = [];
  const indices = new Map<string, number>();
  const toIndices = (referenceIds: readonly string[]) =>
    referenceIds.flatMap((referenceId) => {
      const meta = metaById.get(referenceId);
      if (!meta) return [];
      let index = indices.get(referenceId);
      if (index === undefined) {
        index = references.length;
        indices.set(referenceId, index);
        references.push(meta.referenceKey);
      }
      return [index];
    });
  const always = toIndices([
    ...plan.preloads.always,
    ...metaEntries
      .map(([referenceId]) => referenceId)
      .filter((referenceId) => !plan.referenceIds.has(referenceId)),
  ]);
  const files = plan.preloads.files.map(toIndices);
  const asyncCandidates = plan.preloads.staticOnly.flatMap((referenceId) => {
    const index = indices.get(referenceId);
    const meta = metaById.get(referenceId);
    return index === undefined || !meta ? [] : [{ index, importId: meta.importId }];
  });
  const manifest = {
    references,
    always,
    files,
    routes: Object.fromEntries(plan.preloads.routes),
    routeless: plan.preloads.routeless,
    async: asyncPlaceholder,
    stylesheets: Object.fromEntries(
      [...plan.preloads.stylesheets].map(([pattern, referenceIds]) => [
        pattern,
        toIndices(referenceIds),
      ]),
    ),
  };
  return {
    code: `export const routeClientReferences = ${JSON.stringify(manifest)};\n`,
    asyncCandidates,
  };
}

/**
 * Replaces @vitejs/plugin-rsc's client-reference facades with per-reference
 * loaders. With `routes`, the SSR build also exports the client references
 * each App Router route preloads. With `grouping`, production client builds
 * additionally load references that the same App Router routes reach through
 * one shared route group module (see build/client-reference-groups.ts), so a
 * page fetches one chunk per route group instead of one per `"use client"`
 * module.
 */
export function createRscClientReferenceLoadersPlugin(
  options: {
    routes?: RscClientReferenceRouteOptions;
    grouping?: RscClientReferenceGroupingOptions;
    /**
     * Receives the client build's client reference modules: each resolved
     * module id with the keys of the references it registers.
     */
    onClientReferenceModules?: (modules: ReadonlyMap<string, readonly string[]>) => void;
  } = {},
): Plugin {
  const { routes: routeOptions } = options;
  const grouping = routeOptions && options.grouping;
  const loaderPath = resolveShimRuntimeModule("internal/client-reference-loader");
  let rscApi: PluginApi | undefined;
  let root = "";
  let groupingEnabled = false;
  // Client reference id -> signature of the routes that reach it, collected
  // from the RSC graph, which @vitejs/plugin-rsc builds before the client.
  let routeSignatures = new Map<string, string>();
  // What SSR preloads per route, collected from the same RSC graph, which
  // @vitejs/plugin-rsc also builds before the SSR environment.
  let preloadPlan: {
    referenceIds: ReadonlySet<string>;
    preloads: ClientReferencePreloadPlan;
  } | null = null;
  // The client build's client reference modules and the module that makes
  // each a chunk, by resolved id.
  const referenceModules = new Map<string, string>();
  // The SSR build's references that may stream, until renderChunk checks them.
  let asyncCandidates: AsyncReferenceCandidate[] = [];
  // Stands in for the plan's async references until the SSR graph is
  // complete. Random per build, so no string in application code matches it.
  const asyncPlaceholder = `__vinext_async_client_references_${randomBytes(8).toString("hex")}__`;
  const asyncPlaceholderRe = new RegExp(`(["'])${asyncPlaceholder}\\1`, "g");

  return {
    name: "vinext:rsc-client-reference-loaders",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    outputOptions: {
      // Rolldown resolves output options before the build starts, so this sees
      // the client output after every config hook and every outputOptions hook
      // that runs before it, before any group is planned. A plugin registered
      // after vinext that also uses `order: "post"` runs after this one, so
      // chunk groups it adds aren't detected.
      order: "post",
      handler(output) {
        if (this.environment?.name !== "client") return;
        groupingEnabled =
          !!grouping && !hasUserClientChunkGroups(output, grouping.ownClientChunkGroups);
      },
    },
    buildStart() {
      if (this.environment.name === "rsc") {
        routeSignatures = new Map();
        preloadPlan = null;
      }
      if (this.environment.name === "client") {
        referenceModules.clear();
        options.onClientReferenceModules?.(new Map());
      }
    },
    buildEnd(error) {
      if (error || !routeOptions) return;
      if (this.environment.name !== "rsc" || this.environment.mode !== "build") return;
      const manager = rscApi?.manager;
      const routes = routeOptions.getRoutes();
      if (!manager || manager.isScanBuild || !routes) return;

      const clientReferenceIds = new Set(Object.keys(manager.clientReferenceMetaMap));
      const getModuleInfo = (id: string) => this.getModuleInfo(id);
      preloadPlan = {
        referenceIds: clientReferenceIds,
        preloads: collectClientReferencePreloadPlan({
          alwaysRoots: routeOptions.getAlwaysRenderedFiles(),
          canonicalizeModuleId: routeOptions.canonicalizeModuleId,
          clientReferenceIds,
          entryIds: [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isEntry),
          getModuleInfo,
          routelessFiles: routeOptions.getRoutelessFiles(),
          routes,
        }),
      };
      if (!grouping) return;
      routeSignatures = collectClientReferenceRouteSignatures({
        canonicalizeModuleId: routeOptions.canonicalizeModuleId,
        clientReferenceIds,
        getModuleInfo,
        root,
        routes,
        sharedRoots: routeOptions.getSharedRoots(),
      });
    },
    resolveId: {
      filter: { id: CLIENT_REFERENCE_MODULE_RE },
      handler(source) {
        return referenceModules.has(`\0${source}`) ? `\0${source}` : null;
      },
    },
    load: {
      filter: { id: RESOLVED_CLIENT_REFERENCE_MODULE_RE },
      handler(id) {
        return referenceModules.get(id) ?? null;
      },
    },
    transform: {
      filter: { id: CLIENT_REFERENCES_ID_RE },
      async handler(code) {
        const manager = rscApi?.manager;
        if (!manager || manager.isScanBuild) return null;
        const isServer = this.environment.config.consumer === "server";

        // This post-transform runs after @vitejs/plugin-rsc has loaded the
        // client-reference virtual module and populated the manager metadata. The
        // clientChunks option can change facade grouping, but it still emits
        // facades; this replaces the generated facade with per-reference loaders,
        // which import each reference directly or through its route group module,
        // while preserving the manifest fields the RSC plugin writes later in the
        // build.
        const metaEntries = Object.entries(manager.clientReferenceMetaMap).filter(
          ([, meta]) => meta.serverChunk,
        );
        const metas = metaEntries.map(([, meta]) => meta);
        // The SSR entry imports the preload plan, so emit it even without
        // client references. Development has no plan: plugin-rsc loads each
        // client reference on demand there.
        let routeClientReferencesExport = "";
        if (isServer) {
          const generated = generateRouteClientReferencesExport(
            preloadPlan,
            metaEntries,
            asyncPlaceholder,
          );
          routeClientReferencesExport = generated.code;
          asyncCandidates = generated.asyncCandidates;
        }
        if (metas.length === 0) {
          return isServer ? { code: `${code}\n${routeClientReferencesExport}`, map: null } : null;
        }

        for (const [id, meta] of metaEntries) {
          // The RSC assets manifest indexes deps by Rollup/Rolldown module ids
          // from chunk.moduleIds. Keep the resolved map key here; meta.importId
          // can be a bare package specifier for node_modules client references.
          meta.groupChunkId = id;
        }

        const isClientBuild =
          this.environment.name === "client" && this.environment.mode === "build";
        // The client build's client reference modules, by resolved id, with the
        // keys of the references each registers.
        const moduleKeys = new Map<string, string[]>();
        const grouped = new Set<RscClientReferenceMeta>();
        const referenceIds = new Set(metaEntries.map(([referenceId]) => referenceId));
        const referenceKeys = new Map(
          metaEntries.map(([referenceId, meta]) => [referenceId, meta.referenceKey]),
        );
        if (
          grouping &&
          groupingEnabled &&
          isClientBuild &&
          // Skip measuring when no two references share a signature.
          planClientReferenceGroups({
            referenceIds,
            referenceKeys,
            signatures: routeSignatures,
            costs: new Map([...referenceIds].map((referenceId) => [referenceId, 0])),
            maxCostBytes: 0,
          }).length > 0
        ) {
          // Reference ids come from the RSC graph; resolve each import id in this
          // environment so packages are measured through their browser entry.
          const references = new Map<string, string>();
          const resolutions = new Map<string, Rollup.ResolvedId>();
          // Package metadata for the cost estimate: from resolutions, and for
          // relative imports matched without resolving, from their importer in
          // the same package when its `sideEffects` flag covers every file.
          const packages = new Map<string, PackageMetadata>();
          const externalIds = new Set<string>();
          const uniformSideEffects = new Map<string, boolean>();
          const resolveCache = new Map<string, Promise<string | null>>();
          const addResolution = (resolved: Rollup.ResolvedId) => {
            resolutions.set(resolved.id, resolved);
            packages.set(resolved.id, resolved);
          };
          await Promise.all(
            metaEntries.map(async ([referenceId, meta]) => {
              if (meta.importId.startsWith("\0")) {
                references.set(referenceId, meta.importId);
                return;
              }
              const resolved = await this.resolve(meta.importId);
              if (!resolved || resolved.external) return;
              references.set(referenceId, resolved.id);
              addResolution(resolved);
            }),
          );
          const { external } = this.environment.config.build.rolldownOptions;
          // Every reference's walk checks the modules it reaches, so shared
          // modules are checked once per reference. Cache the checks that depend
          // only on the id; externals are learned while the walk resolves.
          const excludedById = new Map<string, boolean>();
          const isExcludedById = (moduleId: string) => {
            let excluded = excludedById.get(moduleId);
            if (excluded === undefined) {
              excluded =
                !isMeasured(moduleId) ||
                moduleId === CLIENT_REFERENCES_ID ||
                moduleId.startsWith(RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX) ||
                isCSSRequest(moduleId) ||
                grouping.isAlwaysLoadedClientModule(moduleId);
              excludedById.set(moduleId, excluded);
            }
            return excluded;
          };
          // Measure every reference, not just grouping candidates, so code shared
          // with an ungroupable reference still counts as shared.
          const costs = await measureClientReferenceGroupCosts({
            references,
            loadModule: async (moduleId) => {
              // Rolldown never settles a load of an external id. Without an
              // `external` option, externals (URLs, unresolved requires) are
              // never absolute paths, which isMeasured already skips.
              if (external && !resolutions.has(moduleId) && !moduleId.startsWith("\0")) {
                const resolved = await this.resolve(moduleId);
                if (!resolved || resolved.external) return { code: "", importedIds: [] };
              }
              // Pass the full resolution so package metadata such as
              // `sideEffects` is kept for modules this loads first.
              const info = await this.load(resolutions.get(moduleId) ?? { id: moduleId });
              const { code, importedIds } = info;
              if (code === null) return { code, importedIds };
              const importedIdSet = new Set(importedIds);
              const owner = packages.get(moduleId);
              const bindings = await readClientModuleBindings({
                code,
                importedIds,
                resolve: async (specifier) => {
                  // Almost every relative import names the file it resolves to.
                  // When that file provably shares its importer's package
                  // metadata, match it against the imported ids instead of
                  // resolving it.
                  if (
                    owner &&
                    path.isAbsolute(moduleId) &&
                    (specifier.startsWith("./") || specifier.startsWith("../"))
                  ) {
                    const candidate = path.resolve(path.dirname(moduleId), specifier);
                    if (
                      importedIdSet.has(candidate) &&
                      isInPackage(candidate, owner, uniformSideEffects)
                    ) {
                      packages.set(candidate, owner);
                      return candidate;
                    }
                  }
                  // Resolution depends on the importer's directory, and many
                  // modules of a package share a directory and its imports.
                  const key = `${path.dirname(moduleId)}\0${specifier}`;
                  let resolving = resolveCache.get(key);
                  if (!resolving) {
                    resolving = this.resolve(specifier, moduleId).then((resolved) => {
                      if (!resolved) return null;
                      if (resolved.external) externalIds.add(resolved.id);
                      else addResolution(resolved);
                      return resolved.id;
                    });
                    resolveCache.set(key, resolving);
                  }
                  return resolving;
                },
              });
              return { code, importedIds, bindings };
            },
            // Rolldown's module info never reports `moduleSideEffects: false`,
            // so this reads the flag from the resolution.
            isSideEffectFree: (moduleId) => packages.get(moduleId)?.moduleSideEffects === false,
            isExcluded: (moduleId) => externalIds.has(moduleId) || isExcludedById(moduleId),
          });
          const groups = planClientReferenceGroups({
            referenceIds,
            referenceKeys,
            signatures: routeSignatures,
            costs,
            maxCostBytes: CLIENT_REFERENCE_GROUP_MAX_COST_BYTES,
          });
          const metaById = new Map(metaEntries);
          for (const group of groups) {
            const groupMetas = group.referenceIds.map((referenceId) => metaById.get(referenceId)!);
            const resolvedGroupId = `${RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX}${group.key}`;
            referenceModules.set(
              resolvedGroupId,
              generateClientReferenceModule(groupMetas, loaderPath),
            );
            moduleKeys.set(
              resolvedGroupId,
              groupMetas.map((meta) => meta.referenceKey),
            );
            for (const meta of groupMetas) {
              // Asset deps for every member come from the shared group chunk.
              meta.groupChunkId = resolvedGroupId;
              grouped.add(meta);
            }
          }
        }

        if (isClientBuild) {
          // With vinext's own chunk groups, references whose modules are in
          // chunks every page loads, such as vinext's own client components,
          // register as the browser entry loads, from a module in the vinext
          // chunk. Their rows name no chunk.
          const eager: RscClientReferenceMeta[] = [];
          for (const [referenceId, meta] of metaEntries) {
            if (grouped.has(meta)) continue;
            if (grouping && groupingEnabled && grouping.isAlwaysLoadedClientModule(referenceId)) {
              eager.push(meta);
              continue;
            }
            // Named after the reference's file, without its extension, so
            // chunk groups that match source extensions leave it alone.
            const fileName = path.basename(meta.importId).replace(/\.[^.]*$/, "");
            const moduleId = `${RESOLVED_CLIENT_REFERENCE_MODULE_PREFIX}${meta.referenceKey}/${fileName}`;
            referenceModules.set(moduleId, generateClientReferenceModule([meta], loaderPath));
            moduleKeys.set(moduleId, [meta.referenceKey]);
            meta.groupChunkId = moduleId;
          }
          if (eager.length > 0) {
            referenceModules.set(
              RESOLVED_EAGER_CLIENT_REFERENCES_ID,
              generateClientReferenceModule(eager, loaderPath),
            );
          }
          referenceModules.set(
            RESOLVED_CLIENT_REFERENCE_CHUNKS_ID,
            generateClientReferenceChunksModule([...moduleKeys.keys()].sort()),
          );
          // Vite drops entry exports in app client builds; keep the imports.
          this.emitFile({
            type: "chunk",
            id: CLIENT_REFERENCE_CHUNKS_ID,
            preserveSignature: "strict",
          });
          options.onClientReferenceModules?.(moduleKeys);
          return {
            code: generateBrowserClientReferencesModule(loaderPath, eager.length > 0),
            map: null,
          };
        }
        return {
          code: generateClientReferenceLoaders(metas) + routeClientReferencesExport,
          map: null,
        };
      },
    },
    async renderChunk(code, _chunk, _outputOptions, meta) {
      if (this.environment.config.consumer !== "server") return null;
      if (!code.includes(asyncPlaceholder)) return null;
      // The SSR output is complete once chunks render: find the candidates
      // whose modules await at their top level, or import one that does.
      const roots = new Map<string, number[]>();
      await Promise.all(
        asyncCandidates.map(async ({ index, importId }) => {
          let id: string | undefined = importId;
          if (!importId.startsWith("\0") && !path.isAbsolute(importId)) {
            const resolved = await this.resolve(importId);
            id = resolved && !resolved.external ? resolved.id : undefined;
          }
          if (id === undefined) return;
          let list = roots.get(id);
          if (!list) roots.set(id, (list = []));
          list.push(index);
        }),
      );
      const asyncModules = collectAsyncModules({
        roots: [...roots.keys()],
        getModuleInfo: (id) => this.getModuleInfo(id),
        chunks: Object.values(meta.chunks),
        declaresSideEffects: createSideEffectsDeclarationCheck(),
      });
      const asyncIndices = [...asyncModules].flatMap((id) => roots.get(id)!).sort((a, b) => a - b);
      const output = new MagicString(code);
      for (const match of code.matchAll(asyncPlaceholderRe)) {
        output.overwrite(match.index, match.index + match[0].length, JSON.stringify(asyncIndices));
      }
      return omitUnusedBuildSourcemap(this.environment, magicStringTransformResult(output));
    },
  };
}

/**
 * Exports a null preload plan from the client-references virtual module when
 * the app registers @vitejs/plugin-rsc itself (`rsc: false`), where vinext
 * doesn't add the loaders plugin above. The App Router SSR entry imports the
 * plan, and null makes it preload every client reference.
 */
export function createRouteClientReferencesFallbackPlugin(): Plugin {
  return {
    name: "vinext:route-client-references-fallback",
    enforce: "post",
    transform: {
      filter: { id: CLIENT_REFERENCES_ID_RE },
      handler(code) {
        if (this.environment.config.consumer !== "server") return null;
        return {
          code: `${code}\n${NO_ROUTE_CLIENT_REFERENCES_EXPORT}`,
          map: null,
        };
      },
    },
  };
}
