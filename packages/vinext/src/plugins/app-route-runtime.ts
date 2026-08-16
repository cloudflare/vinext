import { readFile } from "node:fs/promises";
import MagicString from "magic-string";
import path from "pathslash";
import { parseAst, type Plugin, type ResolvedConfig } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import type { AppRouteRuntime } from "../build/app-route-runtime.js";

const APP_ROUTE_RUNTIME_QUERY = "__vinext_app_runtime";
const APP_ROUTE_RUNTIME_REFERENCE_OWNER = "vinext:app-route-runtime";
const VITE_RSC_ENCRYPTION_KEY_ID = "\0virtual:vite-rsc/encryption-key";

const SCRIPT_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/i;
const NON_SCRIPT_EXTENSION_RE =
  /\.(?:avif|bmp|css|csv|eot|gif|html?|ico|jpe?g|json|md|mp3|mp4|ogg|otf|pdf|png|svg|tiff?|txt|wav|webm|webp|woff2?|wasm|xml|ya?ml)$/i;

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

async function hasModuleDirective(
  id: string,
  directive: "use client" | "use server",
): Promise<boolean> {
  const pathname = splitId(id).pathname;
  if (!path.isAbsolute(pathname) || pathname.startsWith("\0")) return false;

  let code: string;
  try {
    code = await readFile(pathname, "utf8");
  } catch {
    return false;
  }

  const extension = path.extname(pathname).slice(1);
  const lang =
    extension === "tsx" || extension === "ts" ? extension : extension === "jsx" ? "jsx" : "js";
  try {
    const ast = parseAst(code, { lang });
    for (const statement of ast.body) {
      if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") {
        break;
      }
      if (statement.directive === directive) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasUseClientDirective(id: string): Promise<boolean> {
  return hasModuleDirective(id, "use client");
}

function hasUseServerDirective(id: string): Promise<boolean> {
  return hasModuleDirective(id, "use server");
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
  const extension = path.extname(splitId(id).pathname).slice(1);
  const lang =
    extension === "tsx" || extension === "ts" ? extension : extension === "jsx" ? "jsx" : "js";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
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

  return {
    name: "vinext:app-route-runtime",
    enforce: "pre",
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

      const canonicalResolvedId = withoutAppRouteRuntime(resolved.id);
      const isUseClientModule = await hasUseClientDirective(resolved.id);
      // The RSC scan stops at a canonical client boundary. Remember that the
      // boundary belongs to an edge route so the following SSR reference scan
      // can carry that reachability through client imports to `use server`.
      if (runtime === "edge" && isUseClientModule) {
        edgeClientModules.add(canonicalResolvedId);
      }
      if (isEdgeClientImport) {
        if (await hasUseServerDirective(resolved.id)) {
          await pluginOptions.onEdgeServerReference?.(canonicalResolvedId, this.environment.config);
        } else {
          edgeClientModules.add(canonicalResolvedId);
        }
      }

      if (!runtime || isUseClientModule) return resolved;
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
