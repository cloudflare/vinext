import { parseAst, type Plugin } from "vite";

// Ported from Next.js `assert_client_graph`:
// crates/next-custom-transforms/src/transforms/react_server_components.rs
// `server-only` is on the same list there; vinext validates it separately in
// `vinext:validate-server-only-client-imports`.
const INVALID_CLIENT_IMPORTS: ReadonlySet<string> = new Set(["next/headers", "next/root-params"]);
const INVALID_CLIENT_LIB_APIS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["next/server", new Set(["after"])],
  [
    "next/cache",
    new Set([
      "revalidatePath",
      "revalidateTag",
      "cacheLife",
      "unstable_cacheLife",
      "cacheTag",
      "unstable_cacheTag",
    ]),
  ],
]);

// An import declaration always spells `import` literally (escaped keywords
// are syntax errors), while its specifier may use escapes such as
// "next\u002fheaders" that only the parsed AST decodes. A module's graph edges
// all come from `import` or `export` declarations, so matching both also sees
// a boundary that only re-exports, and an edit that removes its directive.
const CANDIDATE_MODULE_RE = /\b(?:import|export)\b/;

type InvalidClientImport = {
  /** The module specifier, or the imported API name for library APIs. */
  name: string;
  start: number;
};

type ModuleItem = ReturnType<typeof parseAst>["body"][number];

function readImportedName(specifier: unknown): string | null {
  if (!specifier || typeof specifier !== "object") return null;
  const node = specifier as {
    type?: string;
    imported?: { type?: string; name?: unknown; value?: unknown };
  };
  if (node.type !== "ImportSpecifier" || !node.imported) return null;
  const name = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
  return typeof name === "string" ? name : null;
}

function hasUseClientDirective(body: ModuleItem[]): boolean {
  for (const item of body) {
    if (item.type !== "ExpressionStatement" || typeof item.directive !== "string") return false;
    if (item.directive === "use client") return true;
  }
  return false;
}

type ClientGraphModuleInfo = {
  /** Whether the module starts a `"use client"` boundary. */
  isClientBoundary: boolean;
  invalidImports: InvalidClientImport[];
};

/**
 * Runs on final module code. Server Function and cache modules (which Next.js
 * skips) need no exemption: @vitejs/plugin-rsc and `vinext:use-cache-callable`
 * have already replaced them with server reference proxies that keep none of
 * their imports, while one they did not replace (in a Web Worker bundle, a
 * virtual module, or added by a later plugin) still reaches the browser.
 */
function analyzeClientGraphModule(code: string): ClientGraphModuleInfo {
  const none: ClientGraphModuleInfo = { isClientBoundary: false, invalidImports: [] };
  if (!CANDIDATE_MODULE_RE.test(code)) return none;

  let body: ModuleItem[];
  try {
    body = parseAst(code).body;
  } catch {
    return none;
  }
  const invalidImports: InvalidClientImport[] = [];
  for (const item of body) {
    if (item.type !== "ImportDeclaration") continue;
    const source = item.source.value;
    if (typeof source !== "string") continue;

    if (INVALID_CLIENT_IMPORTS.has(source)) {
      invalidImports.push({ name: source, start: item.start });
    }

    const invalidApis = INVALID_CLIENT_LIB_APIS.get(source);
    if (!invalidApis) continue;
    for (const specifier of item.specifiers) {
      const imported = readImportedName(specifier);
      if (imported && invalidApis.has(imported)) {
        invalidImports.push({ name: imported, start: specifier.start });
      }
    }
  }
  return { isClientBoundary: hasUseClientDirective(body), invalidImports };
}

/**
 * Find the server-only APIs a module imports, in source order. Like Next.js,
 * only top-level static `import` declarations count, the source must match
 * exactly, and library APIs match by imported (not local) name.
 */
export function findInvalidClientImports(code: string): InvalidClientImport[] {
  return analyzeClientGraphModule(code).invalidImports;
}

/**
 * Next.js picks the message by whether the importing file's path starts with
 * the app directory (a plain prefix match, as Next.js does).
 */
export function createInvalidClientImportMessage(
  name: string,
  moduleId: string,
  appDir: string,
): string {
  if (moduleId.startsWith(appDir)) {
    return `You're importing a module that depends on "${name}" into a React Client Component module. This API is only available in Server Components but one of its parents is marked with "use client", so this module is also a Client Component.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering`;
  }
  return `You're importing a module that depends on "${name}". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components`;
}

type ClientGraphServerApisPluginOptions = {
  /** Canonical, slash-separated App Router directory, or null without one. */
  getAppDir: () => string | null;
  /**
   * For a browser Web Worker's plugin container (`worker.plugins`). Vite
   * bundles every worker separately, and a worker is browser code throughout.
   */
  worker?: boolean;
};

/** Whether `id` is, or is imported (at any depth) by, a `"use client"` module. */
function isUnderClientBoundary(
  id: string,
  clientBoundaries: ReadonlySet<string>,
  getImporters: (id: string) => Iterable<string>,
): boolean {
  const seen = new Set<string>();
  const pending = [id];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (clientBoundaries.has(next)) return true;
    pending.push(...getImporters(next));
  }
  return false;
}

/**
 * Fail the build when a module in the client layer imports a request API
 * (`next/headers`, `next/root-params`) or a server-only cache/`after` API,
 * matching Next.js' compile error for modules under a `"use client"`
 * boundary. Those modules are also evaluated during SSR, where module-scope
 * `cookies()` or `headers()` would capture the first request that loads them.
 *
 * Like Next.js, the check needs an App Router and skips `node_modules`.
 *
 * - The browser graph (and every Web Worker bundle) is client layer
 *   throughout: every module under a `"use client"` boundary plus the Pages
 *   Router's page components, without middleware, instrumentation or Pages
 *   data exports, which are stripped first.
 * - The SSR graph also holds Pages Router, middleware and instrumentation
 *   modules, so there a module is checked only when a `"use client"` module
 *   imports it, directly or not. It can differ from the browser graph:
 *   resolution conditions such as `browser` pick different files.
 */
export function createClientGraphServerApisPlugin(
  options: ClientGraphServerApisPluginOptions,
): Plugin {
  // SSR build state: modules opening a "use client" boundary, and modules
  // importing a server API, resolved against the module graph at buildEnd.
  const ssrClientBoundaries = new Set<string>();
  const ssrInvalidImports = new Map<string, InvalidClientImport>();

  return {
    name: "vinext:validate-client-graph-server-apis",
    // Check the final module code, after every other plugin's transform (an
    // app plugin may add imports), but before Vite's dev import analysis
    // rewrites specifiers.
    enforce: "post",
    buildStart() {
      if (this.environment?.name !== "ssr") return;
      ssrClientBoundaries.clear();
      ssrInvalidImports.clear();
    },
    transform: {
      filter: {
        // Any module id: plugins may serve JavaScript under virtual or
        // extensionless ids, and code that does not parse is skipped. vinext's
        // own virtual modules only import request APIs in the RSC entry.
        id: { exclude: /\/node_modules\// },
        code: CANDIDATE_MODULE_RE,
      },
      handler(code, id) {
        const environment = this.environment;
        const environmentName = options.worker ? "client" : environment?.name;
        if (environmentName !== "client" && environmentName !== "ssr") return null;
        const appDir = options.getAppDir();
        if (!appDir) return null;

        const { isClientBoundary, invalidImports } = analyzeClientGraphModule(code);
        const [invalid] = invalidImports;
        if (environmentName === "client") {
          if (invalid) {
            this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
          }
          return null;
        }

        if (isClientBoundary) ssrClientBoundaries.add(id);
        else ssrClientBoundaries.delete(id);
        if (!invalid) return null;
        if (environment.mode === "build") {
          ssrInvalidImports.set(id, invalid);
          return null;
        }
        if (environment.mode !== "dev") return null;
        // In dev the importer that triggered this load is already in the graph.
        const getImporters = (moduleId: string) => {
          const importers: string[] = [];
          for (const importer of environment.moduleGraph.getModuleById(moduleId)?.importers ?? []) {
            if (importer.id) importers.push(importer.id);
          }
          return importers;
        };
        if (isUnderClientBoundary(id, ssrClientBoundaries, getImporters)) {
          this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
        }
        return null;
      },
    },
    buildEnd() {
      if (this.environment?.name !== "ssr" || ssrInvalidImports.size === 0) return;
      const appDir = options.getAppDir();
      if (!appDir) return;
      const getImporters = (moduleId: string) => {
        const info = this.getModuleInfo(moduleId);
        return info ? [...info.importers, ...info.dynamicImporters] : [];
      };
      for (const [id, invalid] of ssrInvalidImports) {
        if (isUnderClientBoundary(id, ssrClientBoundaries, getImporters)) {
          this.error({ id, message: createInvalidClientImportMessage(invalid.name, id, appDir) });
        }
      }
    },
  };
}
