import { parseAst, transformWithOxc, type DevEnvironment, type Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path, { toSlash } from "pathslash";

const REFERENCE_VALIDATION_ID_PREFIX = "\0virtual:vite-rsc/reference-validation?";
const SERVER_ACTION_VALIDATION_ID = "virtual:vinext-server-action-validation";
const RESOLVED_SERVER_ACTION_VALIDATION_ID = `\0${SERVER_ACTION_VALIDATION_ID}`;
const RSC_ACTION_SOURCE_SCAN_ID = "virtual:vinext-rsc-action-source-scan";

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

type RscReferenceMeta =
  | PluginApi["manager"]["clientReferenceMetaMap"][string]
  | PluginApi["manager"]["serverReferenceMetaMap"][string];

function parseReferenceValidationQuery(id: string): {
  type?: string;
  id?: string;
  actionId?: string;
  hasAny?: string;
  pathname?: string;
} | null {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return null;
  return Object.fromEntries(new URLSearchParams(id.slice(queryStart + 1)));
}

function normalizeReferenceKey(id: string): string {
  return id.replaceAll("\0", "__x00__");
}

function hasReference(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  referenceId: string | undefined,
): boolean {
  if (!referenceMetaMap || !referenceId) return false;

  const normalizedReferenceId = normalizeReferenceKey(referenceId);
  return Object.values(referenceMetaMap).some(
    (meta) => normalizeReferenceKey(meta.referenceKey) === normalizedReferenceId,
  );
}

async function scanSourceGraph(environment: DevEnvironment, root: string): Promise<Set<string>> {
  const pending = [root];
  const visited = new Set<string>();
  const reachableIds = new Set<string>();

  while (pending.length > 0) {
    const url = pending.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);

    await environment.transformRequest(url);
    const module = await environment.moduleGraph.getModuleByUrl(url);
    if (!module) continue;

    if (module.id) reachableIds.add(cleanFileId(module.id));
    reachableIds.add(cleanFileId(module.url));

    for (const dependency of module.importedModules) {
      const dependencyId = dependency.id ?? dependency.url;
      if (dependency.type === "js" && !dependencyId.includes("virtual:vite-rsc/")) {
        pending.push(dependency.url);
      }
    }
  }

  return reachableIds;
}

function cleanFileId(id: string): string {
  const queryIndex = id.search(/[?#]/);
  const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);
  return toSlash(cleanId.startsWith("/@fs/") ? cleanId.slice("/@fs/".length) : cleanId);
}

type DevActionSourceOptions = {
  getAppDir?: () => string | undefined;
  getPageExtensions?: () => readonly string[] | undefined;
  getRoot?: () => string | undefined;
};

type DevActionSourceSnapshot = {
  actionSourceIds: Set<string>;
  hasAnySourceAction: boolean;
  reachableIds: Set<string>;
};

type AstNode = { type?: string; [key: string]: unknown };

const APP_ACTION_ROOT_BASENAMES = new Set([
  "default",
  "error",
  "forbidden",
  "global-error",
  "global-not-found",
  "layout",
  "loading",
  "not-found",
  "page",
  "route",
  "template",
  "unauthorized",
]);

function parserLanguageForFile(file: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".tsx") return "tsx";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".jsx") return "jsx";
  return "js";
}

function isDirectiveBody(node: AstNode, parent: AstNode | null): boolean {
  if (node.type === "Program") return true;
  if (node.type !== "BlockStatement") return false;
  return Boolean(parent?.type?.includes("Function") || parent?.type === "ArrowFunctionExpression");
}

function bodyHasUseServerDirective(node: AstNode, parent: AstNode | null): boolean {
  if (!isDirectiveBody(node, parent) || !Array.isArray(node.body)) return false;
  for (const statement of node.body as AstNode[]) {
    if (statement.type !== "ExpressionStatement") break;
    const expression = statement.expression as AstNode | undefined;
    const value = expression?.value;
    if (typeof value !== "string") break;
    if (value === "use server") return true;
  }
  return false;
}

function hasRuntimeModuleEdge(node: AstNode): boolean {
  if (node.importKind === "type" || node.exportKind === "type") return false;
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return true;
  return (node.specifiers as AstNode[]).some(
    (specifier) => specifier.importKind !== "type" && specifier.exportKind !== "type",
  );
}

function walkAst(
  node: unknown,
  visit: (node: AstNode, parent: AstNode | null) => void,
  parent: AstNode | null = null,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit, parent);
    return;
  }

  const astNode = node as AstNode;
  visit(astNode, parent);
  for (const [key, value] of Object.entries(astNode)) {
    if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
    if (value && typeof value === "object") walkAst(value, visit, astNode);
  }
}

async function readSourceModuleFacts(
  code: string,
  file: string,
): Promise<{
  hasServerAction: boolean;
  specifiers: string[];
} | null> {
  const sourceLanguage = parserLanguageForFile(file);
  let sourceAst: ReturnType<typeof parseAst>;
  try {
    sourceAst = parseAst(code, { lang: sourceLanguage });
  } catch {
    // A broken unrelated route must not prevent capability discovery for a
    // valid page. Its own request will still surface the parse error normally.
    return null;
  }

  let hasServerAction = false;
  walkAst(sourceAst, (node, parent) => {
    if (bodyHasUseServerDirective(node, parent)) hasServerAction = true;
  });

  let runtimeAst = sourceAst;
  let sourceSpecifiers: Set<string> | null = null;
  if (sourceLanguage === "ts" || sourceLanguage === "tsx") {
    const authoredSpecifiers = new Set<string>();
    sourceSpecifiers = authoredSpecifiers;
    walkAst(sourceAst, (node) => {
      if (
        node.type !== "ImportDeclaration" &&
        node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration" &&
        node.type !== "ImportExpression"
      ) {
        return;
      }
      const source = node.source as AstNode | undefined;
      if (typeof source?.value === "string") authoredSpecifiers.add(source.value);
    });

    try {
      // The source index must follow the runtime graph rather than every
      // syntactic TypeScript import. OXC performs the same local type erasure
      // as Vite's normal transform, including implicit type-only bindings such
      // as `import { T }` when T is used only in type positions. Parse its
      // emitted module syntax, but keep resolving the unchanged specifiers
      // relative to the original source file below.
      const runtimeCode = (
        await transformWithOxc(code, file, {
          lang: sourceLanguage,
          sourcemap: false,
        })
      ).code;
      runtimeAst = parseAst(runtimeCode, { lang: "jsx" });
    } catch {
      // A broken unrelated route must not prevent capability discovery for a
      // valid page. Its own request will still surface the transform error.
      return null;
    }
  }

  const specifiers = new Set<string>();
  walkAst(runtimeAst, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (!hasRuntimeModuleEdge(node)) return;
      const source = node.source as AstNode | undefined;
      if (
        typeof source?.value === "string" &&
        (!sourceSpecifiers || sourceSpecifiers.has(source.value))
      ) {
        specifiers.add(source.value);
      }
      return;
    }

    if (node.type === "ImportExpression") {
      const source = node.source as AstNode | undefined;
      if (
        typeof source?.value === "string" &&
        (!sourceSpecifiers || sourceSpecifiers.has(source.value))
      ) {
        specifiers.add(source.value);
      }
    }
  });
  return { hasServerAction, specifiers: [...specifiers] };
}

async function collectAppActionRoots(
  appDir: string,
  pageExtensions: readonly string[],
): Promise<string[]> {
  const roots: string[] = [];
  const extensions = new Set(pageExtensions.map((extension) => `.${extension.toLowerCase()}`));
  const pending = [appDir];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const basename = path.basename(entry.name, extension);
      if (extensions.has(extension) && APP_ACTION_ROOT_BASENAMES.has(basename)) roots.push(file);
    }
  }

  return roots;
}

async function scanReachableActionSources(options: {
  appDir: string;
  pageExtensions: readonly string[];
  resolve: (specifier: string, importer: string) => Promise<{ id?: string } | null>;
}): Promise<DevActionSourceSnapshot> {
  const pending = await collectAppActionRoots(options.appDir, options.pageExtensions);
  const actionSourceIds = new Set<string>();
  const reachableIds = new Set<string>();

  while (pending.length > 0) {
    const file = cleanFileId(pending.pop()!);
    if (reachableIds.has(file)) continue;
    reachableIds.add(file);

    let code: string;
    try {
      code = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const facts = await readSourceModuleFacts(code, file);
    if (!facts) continue;
    if (facts.hasServerAction) actionSourceIds.add(file);

    for (const specifier of facts.specifiers) {
      let resolved: { id?: string } | null;
      try {
        resolved = await options.resolve(specifier, file);
      } catch {
        // Resolution errors in another route are request-local build errors,
        // not global action-capability failures.
        continue;
      }
      if (!resolved?.id) continue;
      const dependency = cleanFileId(resolved.id);
      if (!path.isAbsolute(dependency)) continue;
      if (!/\.(?:[cm]?[jt]sx?)$/i.test(dependency)) continue;
      // Keep runtime-reachable package files in the lightweight source index.
      // They are only parsed here; the exact indexed action owner named by a
      // posted ID is the only package module cold-transformed below.
      pending.push(dependency);
    }
  }

  return {
    actionSourceIds,
    hasAnySourceAction: actionSourceIds.size > 0,
    reachableIds,
  };
}

function resolveReachableActionSource(
  actionId: string | undefined,
  root: string | undefined,
  actionSourceIds: ReadonlySet<string>,
): string | null {
  if (!actionId) return null;
  const separator = actionId.lastIndexOf("#");
  if (separator <= 0 || separator === actionId.length - 1) return null;

  const referenceId = cleanFileId(actionId.slice(0, separator));
  if (root && referenceId.startsWith("/")) {
    const rootedReference = cleanFileId(path.resolve(root, `.${referenceId}`));
    if (actionSourceIds.has(rootedReference)) return rootedReference;
  }

  // Vite can key source files outside config.root as /@fs paths. Match only a
  // unique source-indexed owner; exact manifest membership is still checked
  // after the targeted transform, so a suffix collision cannot validate an ID.
  const suffix = referenceId.startsWith("/") ? referenceId : `/${referenceId}`;
  let match: string | null = null;
  for (const file of actionSourceIds) {
    if (!file.endsWith(suffix)) continue;
    if (match !== null) return null;
    match = file;
  }
  return match;
}

function collectReachableServerActions(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  reachableIds: ReadonlySet<string> | null,
): Set<string> {
  const references = new Set<string>();
  if (!referenceMetaMap) return references;

  for (const [id, meta] of Object.entries(referenceMetaMap)) {
    if (
      reachableIds &&
      !reachableIds.has(cleanFileId(id)) &&
      !reachableIds.has(cleanFileId(meta.importId))
    ) {
      continue;
    }
    if (!Array.isArray(meta.exportNames)) continue;
    for (const exportName of meta.exportNames) {
      references.add(`${meta.referenceKey}#${exportName}`);
    }
  }
  return references;
}

/**
 * @vitejs/plugin-rsc stores dev virtual client-reference keys in Vite's encoded
 * `/@id/__x00__...` form, but React's SSR consumer can ask validation for the
 * decoded `/@id/\0...` form. Treat those as equivalent and fall through to the
 * upstream validator for all other invalid references.
 */
export function createRscReferenceValidationNormalizerPlugin(
  sourceOptions: DevActionSourceOptions = {},
): Plugin {
  let rscApi: PluginApi | undefined;
  const serverActionValidationModuleIds = new Set<string>();
  const sourceScanModuleIds = new Set<string>();
  const discoverySnapshots = new Map<
    string,
    { generation: number; hasAnySourceAction: boolean; references: Set<string> }
  >();
  let discoveryGeneration = 0;
  let discoveryQueue = Promise.resolve();

  async function scanDevServerActions(
    pathname: string,
    actionId: string | undefined,
    resolve: (specifier: string, importer: string) => Promise<{ id?: string } | null>,
  ): Promise<{ hasAnySourceAction: boolean; references: Set<string> }> {
    const manager = rscApi?.manager;
    const rscEnvironment = manager?.server?.environments.rsc;
    const ssrEnvironment = manager?.server?.environments.ssr;
    if (!rscEnvironment || !ssrEnvironment) {
      return {
        hasAnySourceAction: false,
        references: collectReachableServerActions(manager?.serverReferenceMetaMap, null),
      };
    }

    const appDir = sourceOptions.getAppDir?.();
    const pageExtensions = sourceOptions.getPageExtensions?.() ?? ["tsx", "ts", "jsx", "js"];
    const sourceSnapshot = appDir
      ? await scanReachableActionSources({ appDir, pageExtensions, resolve })
      : {
          actionSourceIds: new Set<string>(),
          hasAnySourceAction: false,
          reachableIds: new Set<string>(),
        };

    // Transform only the posted route's graph. This populates plugin-RSC's
    // exact reference keys without evaluating modules and without allowing a
    // broken, unrelated route to block a valid cold action request.
    const sourceScanUrl = `${RSC_ACTION_SOURCE_SCAN_ID}?pathname=${encodeURIComponent(pathname)}`;
    const rscReachable = await scanSourceGraph(rscEnvironment, sourceScanUrl);
    const sourceScanModule = await rscEnvironment.moduleGraph.getModuleByUrl(sourceScanUrl);
    if (sourceScanModule?.id) sourceScanModuleIds.add(sourceScanModule.id);
    const liveClientReferences = Object.entries(manager.clientReferenceMetaMap).filter(
      ([id, meta]) =>
        rscReachable.has(cleanFileId(id)) || rscReachable.has(cleanFileId(meta.importId)),
    );
    for (const [, meta] of liveClientReferences) {
      await scanSourceGraph(ssrEnvironment, meta.importId);
    }

    const knownReferences = collectReachableServerActions(
      manager.serverReferenceMetaMap,
      appDir ? sourceSnapshot.reachableIds : null,
    );
    if (actionId && !knownReferences.has(actionId)) {
      const ownerSource = resolveReachableActionSource(
        actionId,
        sourceOptions.getRoot?.(),
        sourceSnapshot.actionSourceIds,
      );
      if (ownerSource) {
        // Next.js forwards to the route worker named by its global action
        // manifest. Vinext has one RSC environment, so transforming the exact
        // source-indexed owner establishes the same manifest membership
        // without compiling or evaluating any unrelated route graph.
        await rscEnvironment.transformRequest(`/@fs/${ownerSource}`);
      }
    }

    return {
      hasAnySourceAction: sourceSnapshot.hasAnySourceAction,
      references: collectReachableServerActions(
        manager.serverReferenceMetaMap,
        appDir ? sourceSnapshot.reachableIds : null,
      ),
    };
  }

  async function discoverDevServerActions(
    pathname: string,
    actionId: string | undefined,
    resolve: (specifier: string, importer: string) => Promise<{ id?: string } | null>,
  ): Promise<{ hasAnySourceAction: boolean; references: Set<string> }> {
    const discoveryKey = `${pathname}\0${actionId ?? ""}`;
    for (;;) {
      const cached = discoverySnapshots.get(discoveryKey);
      if (cached?.generation === discoveryGeneration) return cached;

      const generation = discoveryGeneration;
      let result!: { hasAnySourceAction: boolean; references: Set<string> };
      const queued = discoveryQueue.then(async () => {
        const current = discoverySnapshots.get(discoveryKey);
        if (current?.generation === generation) {
          result = current;
          return;
        }
        result = await scanDevServerActions(pathname, actionId, resolve);
        if (generation === discoveryGeneration) {
          discoverySnapshots.set(discoveryKey, { generation, ...result });
        }
      });
      discoveryQueue = queued.catch(() => {});
      await queued;
      if (generation === discoveryGeneration) return result;
      // A hot update landed while the scan was in flight. Retry against the
      // new graph rather than letting stale completion overwrite invalidation.
    }
  }

  return {
    name: "vinext:rsc-reference-validation-normalizer",
    enforce: "pre",
    apply(_config, env) {
      return env.command === "serve" && env.isPreview !== true;
    },
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    resolveId: {
      filter: { id: /^virtual:vinext-server-action-validation(?:\?|$)/ },
      handler(id) {
        if (
          id === SERVER_ACTION_VALIDATION_ID ||
          id.startsWith(`${SERVER_ACTION_VALIDATION_ID}?`)
        ) {
          return `\0${id}`;
        }
        return null;
      },
    },
    load: {
      // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
      filter: {
        // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
        id: /^\u0000virtual:(?:vite-rsc\/reference-validation|vinext-server-action-validation)\?/,
      },
      async handler(id) {
        if (id.startsWith(`${RESOLVED_SERVER_ACTION_VALIDATION_ID}?`)) {
          serverActionValidationModuleIds.add(id);
          const query = parseReferenceValidationQuery(id);
          const pathname = query?.pathname ?? "/";
          const snapshot = await discoverDevServerActions(
            pathname,
            query?.actionId,
            async (specifier, importer) => {
              const resolved = await this.resolve(specifier, importer, { skipSelf: true });
              return resolved ? { id: resolved.id } : null;
            },
          );
          const valid = query?.hasAny
            ? snapshot.hasAnySourceAction || snapshot.references.size > 0
            : Boolean(query?.actionId && snapshot.references.has(query.actionId));
          return `export default ${JSON.stringify(valid)};`;
        }
        if (!id.startsWith(REFERENCE_VALIDATION_ID_PREFIX)) return null;

        const query = parseReferenceValidationQuery(id);
        if (!query) return null;

        const manager = rscApi?.manager;
        if (query.type === "client" && hasReference(manager?.clientReferenceMetaMap, query.id)) {
          return "export {}";
        }

        if (query.type === "server" && hasReference(manager?.serverReferenceMetaMap, query.id)) {
          return "export {}";
        }

        return null;
      },
    },
    hotUpdate: {
      order: "post",
      handler(ctx) {
        // plugin-rsc updates its live reference metadata from the RSC transform
        // during the same hot-update pass. Invalidate our result modules after
        // that transform so the next progressive POST reads the current map.
        // These virtual modules cannot express a normal dependency edge: their
        // input is plugin state rather than source imported by the module.
        if (this.environment.name !== "rsc") return;

        discoveryGeneration++;
        discoverySnapshots.clear();
        for (const id of sourceScanModuleIds) {
          const sourceScanModule = this.environment.moduleGraph.getModuleById(id);
          if (sourceScanModule) {
            this.environment.moduleGraph.invalidateModule(
              sourceScanModule,
              new Set(),
              ctx.timestamp,
              true,
            );
          }
        }

        for (const environment of Object.values(ctx.server.environments)) {
          for (const id of serverActionValidationModuleIds) {
            const mod = environment.moduleGraph.getModuleById(id);
            if (mod) {
              environment.moduleGraph.invalidateModule(mod, new Set(), ctx.timestamp, true);
            }
          }
        }
      },
    },
  };
}
