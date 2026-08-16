import { readFile } from "node:fs/promises";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { parseAst, type Plugin, type ResolvedConfig } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import type { AppRouteRuntime } from "../build/app-route-runtime.js";
import { parserLanguageForModule } from "../utils/parser-language.js";
import { resolveVinextPackageRoot } from "../utils/vinext-root.js";

const APP_ROUTE_RUNTIME_QUERY = "__vinext_app_runtime";
const APP_ROUTE_RUNTIME_REFERENCE_OWNER = "vinext:app-route-runtime";
const VITE_RSC_ENCRYPTION_KEY_ID = "\0virtual:vite-rsc/encryption-key";

const SCRIPT_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/i;
const NON_SCRIPT_EXTENSION_RE =
  /\.(?:avif|bmp|css|csv|eot|gif|html?|ico|jpe?g|json|md|mp3|mp4|ogg|otf|pdf|png|svg|tiff?|txt|wav|webm|webp|woff2?|wasm|xml|ya?ml)$/i;
const NON_EXECUTABLE_SCRIPT_QUERY_KEYS = new Set([
  "inline",
  "no-inline",
  "raw",
  "sharedworker",
  "url",
  "worker",
]);
const VINEXT_PACKAGE_ROOT = resolveVinextPackageRoot();
const FRAMEWORK_RUNTIME_SINGLETON_PATH_RE =
  /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@vinext\/[^/]+|@vitejs\/plugin-rsc|next|react|react-dom|react-server-dom-webpack|scheduler|vinext)(?:\/|$)/;
const FRAMEWORK_RUNTIME_SINGLETONS = [
  "@vitejs/plugin-rsc",
  "next",
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "scheduler",
  "vinext",
] as const;

function isFrameworkRuntimeSingleton(source: string, resolvedId: string): boolean {
  const isFrameworkSpecifier =
    source.startsWith("@vinext/") ||
    FRAMEWORK_RUNTIME_SINGLETONS.some(
      (specifier) => source === specifier || source.startsWith(`${specifier}/`),
    );
  if (isFrameworkSpecifier) return true;

  const resolvedPathname = toSlash(splitId(resolvedId).pathname);
  if (
    resolvedPathname.startsWith("\0vinext-") ||
    resolvedPathname.startsWith("\0virtual:vinext-") ||
    resolvedPathname.startsWith("virtual:vinext-")
  ) {
    return true;
  }
  if (FRAMEWORK_RUNTIME_SINGLETON_PATH_RE.test(resolvedPathname)) return true;
  if (!path.isAbsolute(resolvedPathname)) return false;

  const relativeToVinext = path.relative(VINEXT_PACKAGE_ROOT, resolvedPathname);
  return (
    relativeToVinext === "" || (!relativeToVinext.startsWith("../") && relativeToVinext !== "..")
  );
}

function splitId(id: string): { pathname: string; query: string; search: URLSearchParams } {
  const queryIndex = id.indexOf("?");
  const query = queryIndex === -1 ? "" : id.slice(queryIndex + 1);
  return {
    pathname: queryIndex === -1 ? id : id.slice(0, queryIndex),
    query,
    search: new URLSearchParams(query),
  };
}

export function withoutAppRouteRuntime(id: string): string {
  const { pathname, query } = splitId(id);
  const remainingQuery = query
    .split("&")
    .filter((part) => part.split("=", 1)[0] !== APP_ROUTE_RUNTIME_QUERY)
    .join("&");
  return remainingQuery ? `${pathname}?${remainingQuery}` : pathname;
}

function runtimeFromId(id: string): AppRouteRuntime | null {
  const runtime = splitId(id).search.get(APP_ROUTE_RUNTIME_QUERY);
  return runtime === "edge" || runtime === "nodejs" ? runtime : null;
}

export function withAppRouteRuntime(id: string, runtime: AppRouteRuntime): string {
  const idWithoutRuntime = withoutAppRouteRuntime(id);
  return `${idWithoutRuntime}${idWithoutRuntime.includes("?") ? "&" : "?"}${APP_ROUTE_RUNTIME_QUERY}=${runtime}`;
}

type ServerReferenceStore = Pick<
  PluginApi["manager"]["serverReferences"],
  "metaMap" | "replaceClaim" | "resolve"
>;

type CreateAppRouteRuntimePluginOptions = {
  onEdgeServerReference?: (importId: string, config: ResolvedConfig) => Promise<void> | void;
};

/**
 * Allow plugin-rsc's dev reference validator to admit the edge-qualified id.
 * Loading the action immediately afterward runs plugin-rsc's normal transform,
 * which replaces this placeholder with the discovered export metadata.
 */
export function registerAppRouteRuntimeDevServerReference(
  serverReferences: ServerReferenceStore,
  canonicalImportId: string,
): void {
  const edgeImportId = withAppRouteRuntime(canonicalImportId, "edge");
  if (serverReferences.metaMap.has(edgeImportId)) return;

  serverReferences.replaceClaim(APP_ROUTE_RUNTIME_REFERENCE_OWNER, edgeImportId, {
    ...serverReferences.resolve(edgeImportId, "rsc"),
    exportNames: [],
  });
}

/**
 * Register edge-qualified loaders before plugin-rsc generates its production
 * server-reference module. Client boundaries stay canonical, so an action
 * imported only by client code is otherwise absent from the edge graph.
 */
export function registerAppRouteRuntimeServerReferences(
  serverReferences: ServerReferenceStore,
  edgeServerReferenceImportIds: Iterable<string>,
): void {
  const byImportId = new Map(
    [...serverReferences.metaMap.values()].map((meta) => [meta.importId, meta]),
  );

  for (const canonicalImportId of edgeServerReferenceImportIds) {
    const canonicalMeta = byImportId.get(canonicalImportId);
    if (!canonicalMeta) continue;

    const edgeImportId = withAppRouteRuntime(canonicalMeta.importId, "edge");
    if (serverReferences.metaMap.has(edgeImportId)) continue;

    serverReferences.replaceClaim(APP_ROUTE_RUNTIME_REFERENCE_OWNER, edgeImportId, {
      ...serverReferences.resolve(edgeImportId, "rsc"),
      exportNames: canonicalMeta.exportNames,
    });
  }
}

export function createAppRouteRuntimeServerReferenceMap(
  serverReferences: Pick<ServerReferenceStore, "metaMap">,
): Record<string, string> {
  const metas = [...serverReferences.metaMap.values()];
  const byImportId = new Map(metas.map((meta) => [meta.importId, meta]));
  const runtimeMap: Record<string, string> = {};

  for (const edgeMeta of metas) {
    if (runtimeFromId(edgeMeta.importId) !== "edge") continue;
    const canonicalMeta = byImportId.get(withoutAppRouteRuntime(edgeMeta.importId));
    if (!canonicalMeta || canonicalMeta.referenceKey === edgeMeta.referenceKey) continue;
    runtimeMap[canonicalMeta.referenceKey] = edgeMeta.referenceKey;
  }

  return runtimeMap;
}

function canLoadAsScriptModule(id: string): boolean {
  const { pathname, search } = splitId(id);
  if (pathname === VITE_RSC_ENCRYPTION_KEY_ID) return false;
  if ([...search.keys()].some((key) => NON_EXECUTABLE_SCRIPT_QUERY_KEYS.has(key))) return false;
  if (pathname.toLowerCase().endsWith(".mdx")) {
    // Plain MDX is executable source after vinext's MDX transform. Preserve
    // query imports such as ?raw/?url as assets; only vinext's own runtime
    // qualifier is allowed to remain on a script-classified MDX module.
    return [...search.keys()].every((key) => key === APP_ROUTE_RUNTIME_QUERY);
  }
  return (
    pathname.startsWith("\0") ||
    pathname.startsWith("virtual:") ||
    SCRIPT_EXTENSION_RE.test(pathname) ||
    !NON_SCRIPT_EXTENSION_RE.test(pathname)
  );
}

type ModuleDirectives = { useClient: boolean; useServer: boolean };
const NO_MODULE_DIRECTIVES: ModuleDirectives = { useClient: false, useServer: false };

async function readModuleDirectives(id: string): Promise<ModuleDirectives> {
  const pathname = splitId(id).pathname;
  if (!path.isAbsolute(pathname) || pathname.startsWith("\0")) return NO_MODULE_DIRECTIVES;

  let code: string;
  try {
    code = await readFile(pathname, "utf8");
  } catch {
    return NO_MODULE_DIRECTIVES;
  }

  try {
    const ast = parseAst(code, { lang: parserLanguageForModule(pathname) });
    let useClient = false;
    let useServer = false;
    for (const statement of ast.body) {
      if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") {
        break;
      }
      if (statement.directive === "use client") useClient = true;
      if (statement.directive === "use server") useServer = true;
    }
    return { useClient, useServer };
  } catch {
    return NO_MODULE_DIRECTIVES;
  }
}

type AstNode = Record<string, unknown> & { end?: number; start?: number; type?: string };

function walkAst(value: unknown, visitor: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as AstNode;
  if (typeof node.type === "string") visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent") walkAst(child, visitor);
  }
}

function replaceNextRuntime(code: string, id: string, runtime: AppRouteRuntime) {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: parserLanguageForModule(splitId(id).pathname) });
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;
  walkAst(ast.body, (node) => {
    if (node.type !== "MemberExpression" || node.computed !== false) return;
    const property = node.property as AstNode & { name?: unknown };
    const object = node.object as AstNode & {
      computed?: unknown;
      object?: unknown;
      property?: unknown;
    };
    if (
      property?.type !== "Identifier" ||
      property.name !== "NEXT_RUNTIME" ||
      object?.type !== "MemberExpression" ||
      object.computed !== false
    ) {
      return;
    }
    const envProperty = object.property as AstNode & { name?: unknown };
    const processObject = object.object as AstNode & { name?: unknown };
    if (
      envProperty?.type !== "Identifier" ||
      envProperty.name !== "env" ||
      processObject?.type !== "Identifier" ||
      processObject.name !== "process" ||
      typeof node.start !== "number" ||
      typeof node.end !== "number"
    ) {
      return;
    }
    output.overwrite(node.start, node.end, JSON.stringify(runtime));
    changed = true;
  });
  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary", includeContent: true, source: id }),
  };
}

export function createAppRouteRuntimePlugin(
  pluginOptions: CreateAppRouteRuntimePluginOptions = {},
): Plugin {
  const edgeClientModules = new Set<string>();
  const moduleDirectives = new Map<string, Promise<ModuleDirectives>>();

  function getModuleDirectives(id: string): Promise<ModuleDirectives> {
    const pathname = toSlash(splitId(id).pathname);
    const cached = moduleDirectives.get(pathname);
    if (cached) return cached;
    const directives = readModuleDirectives(pathname);
    moduleDirectives.set(pathname, directives);
    return directives;
  }

  return {
    name: "vinext:app-route-runtime",
    enforce: "pre",
    watchChange(id) {
      moduleDirectives.delete(toSlash(splitId(id).pathname));
    },
    async resolveId(source, importer, options) {
      if (this.environment?.name === "client") {
        if (!runtimeFromId(source)) return null;
        return this.resolve(withoutAppRouteRuntime(source), importer, {
          ...options,
          skipSelf: true,
        });
      }

      if (!importer || options?.isEntry) return null;
      const runtime = runtimeFromId(importer);
      const canonicalImporter = withoutAppRouteRuntime(importer);
      const isEdgeClientImport = edgeClientModules.has(canonicalImporter);
      if (!runtime && !isEdgeClientImport) return null;

      const resolved = await this.resolve(source, withoutAppRouteRuntime(importer), {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external || !canLoadAsScriptModule(resolved.id)) {
        return resolved;
      }

      // These packages own shared React/RSC/framework state. Giving them a
      // second query-qualified identity splits dispatchers, request contexts,
      // asset transforms, and plugin-rsc registries. The matched user route
      // graph still receives the runtime qualifier, but stops at this runtime
      // boundary just as separate Next.js route bundles share their framework
      // runtime.
      if (isFrameworkRuntimeSingleton(source, resolved.id)) return resolved;

      const canonicalResolvedId = withoutAppRouteRuntime(resolved.id);
      const directives = await getModuleDirectives(resolved.id);
      // The RSC scan stops at a canonical client boundary. Remember that the
      // boundary belongs to an edge route so the following SSR reference scan
      // can carry that reachability through client imports to `use server`.
      if (runtime === "edge" && directives.useClient) {
        edgeClientModules.add(canonicalResolvedId);
      }
      if (isEdgeClientImport) {
        if (directives.useServer) {
          await pluginOptions.onEdgeServerReference?.(canonicalResolvedId, this.environment.config);
        } else {
          edgeClientModules.add(canonicalResolvedId);
        }
      }

      if (!runtime || directives.useClient) return resolved;
      return {
        ...resolved,
        id: withAppRouteRuntime(resolved.id, runtime),
      };
    },
    transform: {
      filter: { id: /[?&]__vinext_app_runtime=(?:edge|nodejs)(?:&|$)/ },
      handler(code, id) {
        if (this.environment?.name === "client") return null;
        const runtime = runtimeFromId(id);
        if (!runtime || !code.includes("process.env.NEXT_RUNTIME")) return null;
        return replaceNextRuntime(code, id, runtime);
      },
    },
  };
}
