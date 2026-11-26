/**
 * `navigator.serviceWorker.register(new URL("./sw", import.meta.url), options)`
 * support, ported from Next.js 16.4's Turbopack implementation:
 *
 * - turbopack/crates/turbopack-ecmascript/src/references/service_worker.rs
 *   (call analysis, scope-derived file names, call rewrite)
 * - crates/next-api/src/service_worker.rs (one self-contained bundle per
 *   scope, conflicting-registration error)
 * - packages/next/src/server/lib/router-server.ts and build/index.ts
 *   (`Cache-Control: public, max-age=0, must-revalidate` and
 *   `Service-Worker-Allowed` on `/_next/static/service-worker/*`)
 *
 * Client modules have the call rewritten to
 * `register("<basePath>/_next/static/service-worker/<file>", { ...options, scope })`.
 * Each registered worker is compiled into one self-contained classic script,
 * emitted into the client build at that path, or served by the dev server.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { build, type ESTree, type Plugin, type ResolvedConfig, type Rolldown } from "vite";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { stripViteModuleQuery } from "../utils/path.js";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";
import {
  SERVICE_WORKER_CACHE_CONTROL,
  SERVICE_WORKER_URL_DIR,
  serviceWorkerAllowedHeader,
  serviceWorkerOutputDir,
} from "../utils/service-worker.js";
import {
  isIdentifierNamed,
  parseProgram,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  walkAst,
} from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

const DEFAULT_SCOPE = "/";
const URL_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;

/**
 * The file name a worker registered at `scope` is served under. Matches
 * Turbopack's `service_worker_chunk_filename`: `sw.js` for the root scope,
 * otherwise a lossy slug of the scope plus a hash of it so distinct scopes
 * never share a file. (Turbopack hashes with xxh3; the hash only has to be
 * stable and distinct, so a truncated SHA-256 is used here.)
 */
export function serviceWorkerFileName(scope: string): string {
  const trimmed = scope.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "sw.js";
  const slug = trimmed.replace(/[^a-zA-Z0-9_-]/g, "-");
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `sw-${slug}-${hash}.js`;
}

/** The scope a worker registered at `scope` gets once `basePath` is applied. */
function serviceWorkerScopeWithBasePath(scope: string, basePath: string): string {
  const base = basePath.replace(/\/+$/, "");
  if (scope === DEFAULT_SCOPE) return base || DEFAULT_SCOPE;
  return `${base}${scope}`;
}

/** The URL pathname a worker registered at `scope` is served at. */
function serviceWorkerUrl(scope: string, basePath: string): string {
  return `${basePath.replace(/\/+$/, "")}/${SERVICE_WORKER_URL_DIR}/${serviceWorkerFileName(scope)}`;
}

export type ServiceWorkerRegistrationCall = {
  /** The `new URL()` specifier, resolved relative to the registering module. */
  specifier: string;
  /** The statically known registration scope (before `basePath`). */
  scope: string;
  /** Source span of the script argument through the last argument. */
  argsStart: number;
  argsEnd: number;
  /** Source span of the user's options argument, when one was passed. */
  options: { start: number; end: number } | null;
};

export type ServiceWorkerCallAnalysis = {
  calls: ServiceWorkerRegistrationCall[];
  warnings: string[];
};

function isImportMetaUrl(node: ESTree.Node | null | undefined): boolean {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    node.object.property.name === "meta" &&
    isIdentifierNamed(node.property, "url")
  );
}

function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  return staticStringValue(node.property);
}

/** Whether `callee` is `navigator.serviceWorker.register`. */
function isServiceWorkerRegister(callee: ESTree.Node): boolean {
  if (callee.type !== "MemberExpression" || memberPropertyName(callee) !== "register") return false;
  const container = callee.object;
  return (
    container.type === "MemberExpression" &&
    memberPropertyName(container) === "serviceWorker" &&
    isIdentifierNamed(container.object, "navigator")
  );
}

/** The relative specifier of `new URL("<specifier>", import.meta.url)`, if `node` is one. */
function relativeWorkerUrlSpecifier(node: ESTree.Node | undefined): string | null {
  if (
    node?.type !== "NewExpression" ||
    !isIdentifierNamed(node.callee, "URL") ||
    node.arguments.length !== 2 ||
    !isImportMetaUrl(node.arguments[1])
  ) {
    return null;
  }
  const specifier = staticStringValue(node.arguments[0]);
  if (specifier === null || URL_SCHEME_RE.test(specifier)) return null;
  return specifier;
}

function propertyKeyName(property: ESTree.ObjectProperty): string | null {
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return staticStringValue(property.key);
}

/**
 * The scope an options argument registers at, or a reason it cannot be known
 * statically. Like Turbopack, a missing options argument, a non-object one, or
 * an object without a `scope` key registers at the default scope "/".
 */
function analyzeScope(options: ESTree.Node | undefined): { scope: string } | { error: string } {
  if (options?.type !== "ObjectExpression") return { scope: DEFAULT_SCOPE };
  let scopeValue: ESTree.Node | undefined;
  for (const property of options.properties) {
    if (property.type === "Property" && propertyKeyName(property) === "scope") {
      scopeValue = property.value;
    }
  }
  if (!scopeValue) return { scope: DEFAULT_SCOPE };
  const scope = staticStringValue(scopeValue);
  if (scope === null) return { error: "has a `scope` that is not statically analyze-able" };
  // The scope must be root-relative so it can be prefixed with `basePath` and
  // served from a stable URL. Turbopack rejects relative scopes rather than
  // registering at the wrong scope.
  if (!scope.startsWith("/")) return { error: "has a `scope` that does not start with `/`" };
  return { scope };
}

/**
 * Find every `navigator.serviceWorker.register(new URL(...), options?)` call
 * whose worker and scope are statically known. Calls with an unanalyzable
 * scope are left untouched and reported as warnings, matching Turbopack.
 */
export function analyzeServiceWorkerCalls(code: string, id: string): ServiceWorkerCallAnalysis {
  const result: ServiceWorkerCallAnalysis = { calls: [], warnings: [] };
  const lang = scriptParserLanguage(id) ?? "js";
  const program = parseProgram(code, { lang });
  walkAst(program, (node) => {
    if (node.type !== "CallExpression" || !isServiceWorkerRegister(node.callee)) return;
    const [scriptArg, optionsArg] = node.arguments;
    const specifier = relativeWorkerUrlSpecifier(scriptArg);
    if (specifier === null || !scriptArg) return;
    const scope = analyzeScope(optionsArg);
    if ("error" in scope) {
      result.warnings.push(
        `navigator.serviceWorker.register(new URL(${JSON.stringify(specifier)}, import.meta.url), ...) ${scope.error}`,
      );
      return;
    }
    const lastArg = node.arguments[node.arguments.length - 1];
    result.calls.push({
      specifier,
      scope: scope.scope,
      argsStart: scriptArg.start,
      argsEnd: lastArg.end,
      options:
        optionsArg && optionsArg.type !== "SpreadElement"
          ? { start: optionsArg.start, end: optionsArg.end }
          : null,
    });
  });
  return result;
}

/**
 * The replacement for a call's arguments: the served script URL, then the
 * user's options with the analyzed scope pinned. Other options (such as
 * `type` or `updateViaCache`) are preserved.
 */
export function serviceWorkerRegisterArguments(
  code: string,
  call: ServiceWorkerRegistrationCall,
  basePath: string,
): string {
  const url = JSON.stringify(serviceWorkerUrl(call.scope, basePath));
  const scope = JSON.stringify(serviceWorkerScopeWithBasePath(call.scope, basePath));
  const options = call.options
    ? `({ ...${code.slice(call.options.start, call.options.end)}, scope: ${scope} })`
    : `({ scope: ${scope} })`;
  return `${url}, ${options}`;
}

type BundledServiceWorker = { code: string; etag: string; moduleIds: Set<string> };

/**
 * Compile one service worker into a single self-contained classic script.
 * Service workers run in their own global scope and load nothing from the
 * page's bundle, so this is an isolated build that reuses the client
 * environment's defines and resolution, like Turbopack's service-worker
 * context reuses the client compile options.
 */
async function bundleServiceWorker(
  config: ResolvedConfig,
  source: string,
  minify: ResolvedConfig["build"]["minify"],
): Promise<BundledServiceWorker> {
  const output = await build({
    configFile: false,
    root: config.root,
    mode: config.mode,
    // Warnings and errors only: the worker is part of the app's build, so a
    // second build banner would be noise.
    logLevel: config.logLevel === "silent" ? "silent" : "warn",
    envDir: config.envDir,
    envPrefix: config.envPrefix,
    define: config.define,
    publicDir: false,
    resolve: {
      alias: config.resolve.alias,
      conditions: config.resolve.conditions,
      mainFields: config.resolve.mainFields,
      extensions: config.resolve.extensions,
    },
    build: {
      write: false,
      copyPublicDir: false,
      emptyOutDir: false,
      reportCompressedSize: false,
      modulePreload: false,
      sourcemap: false,
      minify,
      target: config.build.target,
      rolldownOptions: {
        input: source,
        output: { format: "iife", codeSplitting: false, entryFileNames: "sw.js" },
      },
    },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as Rolldown.RolldownOutput[];
  for (const { output: files } of outputs) {
    for (const file of files) {
      if (file.type === "chunk" && file.isEntry) {
        return {
          code: file.code,
          etag: `"${createHash("sha256").update(file.code).digest("base64url").slice(0, 27)}"`,
          moduleIds: new Set(file.moduleIds.map((moduleId) => toSlash(moduleId))),
        };
      }
    }
  }
  throw new Error(`[vinext] Failed to bundle service worker ${source}`);
}

function formatConflictError(root: string, scope: string, sources: Iterable<string>): string {
  const files = [...sources].map((source) => path.relative(root, source)).sort();
  return (
    "Multiple service workers registered for the same scope.\n" +
    `Multiple service workers with different source files were registered for scope '${scope}'. ` +
    "Each scope serves a single service worker.\n" +
    `Registered source files: ${files.join(", ")}`
  );
}

export function createServiceWorkerPlugin(options: { getBasePath: () => string }): Plugin {
  // Registrations by registering module, so a module that changes in dev
  // replaces (rather than adds to) what it registered.
  const registrationsByImporter = new Map<string, Map<string, string>>();
  const devBundles = new Map<string, Promise<BundledServiceWorker>>();
  let clientConfig: ResolvedConfig | undefined;

  function sourcesByScope(): Map<string, Set<string>> {
    const byScope = new Map<string, Set<string>>();
    for (const registrations of registrationsByImporter.values()) {
      for (const [scope, source] of registrations) {
        let sources = byScope.get(scope);
        if (!sources) byScope.set(scope, (sources = new Set()));
        sources.add(source);
      }
    }
    return byScope;
  }

  /** Workers that can be served: one source per scope, keyed by file name. */
  function servedWorkers(): Map<string, { scope: string; source: string }> {
    const workers = new Map<string, { scope: string; source: string }>();
    for (const [scope, sources] of sourcesByScope()) {
      if (sources.size !== 1) continue;
      const [source] = sources;
      workers.set(serviceWorkerFileName(scope), { scope, source });
    }
    return workers;
  }

  function forgetImporter(id: string): void {
    registrationsByImporter.delete(stripViteModuleQuery(toSlash(id)));
  }

  function invalidateDevBundles(file: string): void {
    const changed = toSlash(file);
    for (const [fileName, bundle] of devBundles) {
      bundle.then(
        (result) => {
          if (result.moduleIds.has(changed) && devBundles.get(fileName) === bundle) {
            devBundles.delete(fileName);
          }
        },
        () => {
          if (devBundles.get(fileName) === bundle) devBundles.delete(fileName);
        },
      );
    }
  }

  async function serveDevWorker(
    req: IncomingMessage,
    res: ServerResponse,
    fileName: string,
  ): Promise<boolean> {
    const worker = servedWorkers().get(fileName);
    if (!worker || !clientConfig) return false;
    let bundle = devBundles.get(fileName);
    if (!bundle) {
      bundle = bundleServiceWorker(clientConfig, worker.source, false);
      devBundles.set(fileName, bundle);
      bundle.catch(() => {
        if (devBundles.get(fileName) === bundle) devBundles.delete(fileName);
      });
    }
    const { code, etag } = await bundle;
    const basePath = options.getBasePath();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", SERVICE_WORKER_CACHE_CONTROL);
    res.setHeader("Service-Worker-Allowed", serviceWorkerAllowedHeader(basePath));
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : code);
    return true;
  }

  return {
    name: "vinext:service-worker",
    applyToEnvironment(environment) {
      return environment.config.consumer === "client";
    },
    buildStart() {
      // A build starts from an empty registry; dev keeps it across rebuilds.
      if (this.environment.mode === "build") registrationsByImporter.clear();
    },
    configureServer(server) {
      clientConfig = server.environments.client?.config ?? server.config;
      // Registered before Vite's internal middlewares, so `req.url` still
      // carries `basePath` and the worker is served before any app routing.
      server.watcher.on("change", invalidateDevBundles);
      server.watcher.on("unlink", (file) => {
        invalidateDevBundles(file);
        forgetImporter(file);
      });
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const prefix = `${options.getBasePath()}/${SERVICE_WORKER_URL_DIR}/`;
        const pathname = (req.url ?? "").split("?", 1)[0];
        if (!pathname.startsWith(prefix)) return next();
        const fileName = pathname.slice(prefix.length);
        if (fileName.includes("/")) return next();
        serveDevWorker(req, res, fileName).then((served) => {
          if (!served) next();
        }, next);
      });
    },
    transform: {
      filter: {
        id: { include: SCRIPT_MODULE_ID_RE, exclude: VIRTUAL_MODULE_ID_RE },
        code: /serviceWorker/,
      },
      async handler(code, id) {
        const importer = stripViteModuleQuery(id);
        if (!code.includes("import.meta")) {
          registrationsByImporter.delete(importer);
          return null;
        }
        const analysis = analyzeServiceWorkerCalls(code, id);
        for (const warning of analysis.warnings) this.warn(warning);
        if (analysis.calls.length === 0) {
          registrationsByImporter.delete(importer);
          return null;
        }

        const registrations = new Map<string, Set<string>>();
        const resolvedSources: string[] = [];
        for (const call of analysis.calls) {
          const resolved = await this.resolve(call.specifier, id);
          if (!resolved || resolved.external) {
            this.error(
              `Module not found: Can't resolve '${call.specifier}' in navigator.serviceWorker.register()`,
            );
          }
          const source = stripViteModuleQuery(toSlash(resolved.id));
          resolvedSources.push(source);
          let sources = registrations.get(call.scope);
          if (!sources) registrations.set(call.scope, (sources = new Set()));
          sources.add(source);
        }

        const own = new Map<string, string>();
        for (const [scope, sources] of registrations) {
          if (sources.size > 1) {
            this.error(formatConflictError(this.environment.config.root, scope, sources));
          }
          own.set(scope, [...sources][0]);
        }
        registrationsByImporter.set(importer, own);
        for (const [scope, sources] of sourcesByScope()) {
          if (own.has(scope) && sources.size > 1) {
            this.error(formatConflictError(this.environment.config.root, scope, sources));
          }
        }

        const basePath = options.getBasePath();
        const s = new MagicString(code);
        for (const call of analysis.calls) {
          s.overwrite(
            call.argsStart,
            call.argsEnd,
            serviceWorkerRegisterArguments(code, call, basePath),
          );
        }
        return magicStringTransformResult(s);
      },
    },
    async generateBundle() {
      const config = this.environment.config;
      const outputDir = serviceWorkerOutputDir(options.getBasePath());
      for (const [fileName, worker] of servedWorkers()) {
        const { code } = await bundleServiceWorker(config, worker.source, config.build.minify);
        this.emitFile({
          type: "asset",
          fileName: `${outputDir}${fileName}`,
          source: code,
        });
      }
    },
  };
}
