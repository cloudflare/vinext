import fs from "node:fs/promises";
import path from "node:path";
import { parseAst, type Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import { forEachAstChild, isAstRecord, nodeArray } from "./ast-utils.js";
import { normalizePathSeparators } from "../utils/path.js";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RESOLVED_ID_PROXY_PREFIX = "virtual:vite-rsc/resolved-id/";

type RscClientReferenceMeta = PluginApi["manager"]["clientReferenceMetaMap"][string];

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

type ClientRouterRuntimeAnalysisOptions = {
  clientReferenceIds: readonly string[];
  readImportSpecifiers: (id: string) => Promise<readonly string[] | null>;
  resolveImport: (
    source: string,
    importer: string,
  ) => Promise<{ external?: boolean; id: string } | null>;
  internalRoot: string;
  routerRuntimeImportSpecifiers: ReadonlySet<string>;
  routerRuntimeModuleIds: readonly string[];
};

type RscClientReferenceLoadersPluginOptions = {
  internalRoot?: string;
  onClientRouterRuntimeAnalysis?: (required: boolean) => void;
  rewriteClientReferenceImportId?: (
    importId: string,
    context: { hasServerActions: boolean },
  ) => string;
  routerRuntimeImportSpecifiers?: readonly string[];
  routerRuntimeModuleIds?: readonly string[];
};

function cleanModuleId(id: string): string {
  return normalizePathSeparators(id.split("?", 1)[0]);
}

function isWithinRoot(id: string, root: string): boolean {
  return id === root || id.startsWith(root + "/");
}

/**
 * Return true unless the final client-reference graph proves that no user
 * client component can reach an App Router state API.
 */
export function clientReferencesRequireRouterRuntime(
  options: ClientRouterRuntimeAnalysisOptions,
): Promise<boolean> {
  return analyzeClientReferences(options);
}

async function analyzeClientReferences(
  options: ClientRouterRuntimeAnalysisOptions,
): Promise<boolean> {
  const internalRoot = cleanModuleId(options.internalRoot).replace(/\/+$/, "");
  const routerRuntimeModuleIds = new Set(options.routerRuntimeModuleIds.map(cleanModuleId));

  for (const clientReferenceId of options.clientReferenceIds) {
    const rootId = cleanModuleId(clientReferenceId);
    if (routerRuntimeModuleIds.has(rootId)) return true;
    if (isWithinRoot(rootId, internalRoot)) continue;

    const pending = [clientReferenceId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;

      const cleanId = cleanModuleId(id);
      if (visited.has(cleanId)) continue;
      visited.add(cleanId);

      if (routerRuntimeModuleIds.has(cleanId)) return true;

      const imports = await options.readImportSpecifiers(cleanId);
      // An unreadable or unparsable JavaScript module means the scan cannot
      // prove that this reference is router-independent.
      if (imports === null) return true;

      for (const source of imports) {
        if (options.routerRuntimeImportSpecifiers.has(source)) return true;
        if (source.startsWith("node:")) continue;

        let resolved: Awaited<ReturnType<typeof options.resolveImport>>;
        try {
          resolved = await options.resolveImport(source, cleanId);
        } catch {
          return true;
        }
        if (resolved === null || resolved.external) return true;
        pending.push(resolved.id);
      }
    }
  }

  return false;
}

const NON_JAVASCRIPT_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".less",
  ".png",
  ".sass",
  ".scss",
  ".svg",
  ".webp",
]);

function getStaticString(value: unknown): string | null {
  if (!isAstRecord(value)) return null;
  return typeof value.value === "string" ? value.value : null;
}

function collectImportSpecifiers(code: string, id: string): string[] | null {
  const extension = path.extname(id).toLowerCase();
  const lang =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".jsx"
          ? "jsx"
          : "js";
  try {
    const ast = parseAst(code, { lang });
    const imports = new Set<string>();

    const visit = (node: Parameters<typeof forEachAstChild>[0]) => {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration") &&
        node.importKind !== "type" &&
        node.exportKind !== "type"
      ) {
        const source = getStaticString(node.source);
        if (source !== null) imports.add(source);
      } else if (node.type === "ImportExpression") {
        const source = getStaticString(node.source);
        if (source !== null) imports.add(source);
      } else if (node.type === "CallExpression") {
        const callee = isAstRecord(node.callee) ? node.callee : null;
        if (callee?.type === "Identifier" && callee.name === "require") {
          const firstArg = nodeArray(node.arguments)[0];
          const source = getStaticString(firstArg);
          if (source !== null) imports.add(source);
        }
      }
      forEachAstChild(node, visit);
    };

    for (const statement of nodeArray(ast.body)) {
      if (isAstRecord(statement)) visit(statement);
    }
    return [...imports];
  } catch {
    return null;
  }
}

async function readImportSpecifiers(id: string): Promise<readonly string[] | null> {
  if (id.startsWith("\0")) return null;
  const cleanId = cleanModuleId(id);
  if (NON_JAVASCRIPT_EXTENSIONS.has(path.extname(cleanId).toLowerCase())) return [];

  try {
    return collectImportSpecifiers(await fs.readFile(cleanId, "utf8"), cleanId);
  } catch {
    return null;
  }
}

function withResolvedIdProxy(resolvedId: string): string {
  return resolvedId.startsWith("\0")
    ? RESOLVED_ID_PROXY_PREFIX + encodeURIComponent(resolvedId)
    : resolvedId;
}

function generateClientReferenceObject(meta: RscClientReferenceMeta): string {
  // Keep exports lazy. In async or cyclic client module evaluation, eagerly
  // copying module namespace values can observe an uninitialized binding.
  const exports = meta.renderedExports
    .slice()
    .sort()
    .map((name) => `      get ${JSON.stringify(name)}() { return m[${JSON.stringify(name)}]; },`)
    .join("\n");

  return exports ? `{\n${exports}\n    }` : "{}";
}

function generateDirectClientReferenceLoaders(
  metas: RscClientReferenceMeta[],
  resolveImportId: (importId: string) => string,
): string {
  const entries = metas
    .slice()
    .sort((a, b) => a.referenceKey.localeCompare(b.referenceKey))
    .map((meta) => {
      const importId = withResolvedIdProxy(resolveImportId(meta.importId));
      return [
        `  ${JSON.stringify(meta.referenceKey)}: async () => {`,
        `    const m = await import(${JSON.stringify(importId)});`,
        `    return ${generateClientReferenceObject(meta)};`,
        `  },`,
      ].join("\n");
    })
    .join("\n");

  return `export default {\n${entries}\n};\n`;
}

export function createRscClientReferenceLoadersPlugin(
  options: RscClientReferenceLoadersPluginOptions = {},
): Plugin {
  let rscApi: PluginApi | undefined;

  return {
    name: "vinext:rsc-client-reference-loaders",
    enforce: "post",
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    transform(_code, id) {
      if (id !== CLIENT_REFERENCES_ID) return null;

      const manager = rscApi?.manager;
      if (!manager || manager.isScanBuild) return null;

      // This post-transform runs after @vitejs/plugin-rsc has loaded the
      // client-reference virtual module and populated the manager metadata. The
      // clientChunks option can change facade grouping, but it still emits
      // facades; this replaces the generated facade with direct loaders while
      // preserving the manifest fields the RSC plugin writes later in the build.
      const metaEntries = Object.entries(manager.clientReferenceMetaMap).filter(
        ([, meta]) => meta.serverChunk,
      );
      const metas = metaEntries.map(([, meta]) => meta);
      if (metas.length === 0) return null;

      for (const [id, meta] of metaEntries) {
        // The RSC assets manifest indexes deps by Rollup/Rolldown module ids
        // from chunk.moduleIds. Keep the resolved map key here; meta.importId
        // can be a bare package specifier for node_modules client references.
        meta.groupChunkId = id;
      }

      return {
        code: generateDirectClientReferenceLoaders(metas, (importId) =>
          options.rewriteClientReferenceImportId
            ? options.rewriteClientReferenceImportId(importId, {
                hasServerActions: Object.keys(manager.serverReferenceMetaMap).length > 0,
              })
            : importId,
        ),
        map: null,
      };
    },
    async generateBundle() {
      const manager = rscApi?.manager;
      if (
        this.environment.name !== "rsc" ||
        !manager?.isScanBuild ||
        options.internalRoot === undefined ||
        options.routerRuntimeImportSpecifiers === undefined ||
        options.routerRuntimeModuleIds === undefined ||
        options.onClientRouterRuntimeAnalysis === undefined
      ) {
        return;
      }

      options.onClientRouterRuntimeAnalysis(
        await clientReferencesRequireRouterRuntime({
          clientReferenceIds: Object.keys(manager.clientReferenceMetaMap),
          readImportSpecifiers,
          resolveImport: async (source, importer) => {
            const resolved = await this.resolve(source, importer);
            return resolved === null
              ? null
              : {
                  id: resolved.id,
                  external: resolved.external !== undefined && resolved.external !== false,
                };
          },
          internalRoot: options.internalRoot,
          routerRuntimeImportSpecifiers: new Set(options.routerRuntimeImportSpecifiers),
          routerRuntimeModuleIds: options.routerRuntimeModuleIds,
        }),
      );
    },
  };
}
