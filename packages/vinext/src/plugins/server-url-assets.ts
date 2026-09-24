/**
 * vinext:server-url-assets — make `new URL("./asset", import.meta.url)` in
 * server code fetchable on every runtime.
 *
 * Next.js's edge compiler treats `new URL(<literal>, import.meta.url)` as an
 * asset dependency: the referenced file (a relative path, or a module request
 * such as `my-pkg/data.json`) is emitted with the edge function, the
 * expression evaluates to a `blob:` URL, and the edge sandbox's `fetch()`
 * serves those URLs from the emitted files
 * (build/webpack/loaders/next-middleware-asset-loader.ts,
 * server/web/sandbox/fetch-inline-assets.ts).
 *
 * Vite leaves the expression alone in server environments (its
 * `vite:asset-import-meta-url` plugin is client-only), so the URL resolves
 * against the emitted chunk at runtime and `fetch()` fails: Node's fetch has no
 * `file:` support and Workers have neither a filesystem nor a file-URL
 * `import.meta.url`.
 *
 * vinext compiles edge and Node.js server code in the same module graph, so
 * this plugin gives every server environment one semantics that serves both:
 *
 *   - The expression becomes `new URL(<href>)`, where `<href>` is the file URL
 *     of the resolved source file. Node.js code that reads it with
 *     `fs.readFile(url)` / `fileURLToPath(url)` keeps working wherever the
 *     sources exist (dev and in-place `vinext start`), matching the source
 *     identity vinext already gives project `import.meta.url` reads.
 *   - The href is registered with the bytes in a lazily imported chunk, and
 *     `fetch()` of a registered href returns them (see
 *     server/server-url-assets.ts). Inlining the bytes is what makes this work
 *     on Workers, where there is no filesystem to read an emitted asset from;
 *     keeping them in a lazy chunk keeps them off startup and the request path
 *     until something actually fetches the asset.
 *
 * Only project modules are rewritten (not node_modules) and only when the
 * literal resolves to an existing file, so runtime-computed URLs and remote
 * URLs keep their current behaviour. Like webpack, the file's extension does
 * not matter (`fetch(new URL("./payload.js", import.meta.url))` loads the
 * source text); the surrounding expression does: a URL built anywhere inside
 * the operand of a code load — `new Worker(...)`, `new SharedWorker(...)`
 * (also as `Reflect.construct`) or `import(...)` — stays a runtime URL.
 * App Router client code is left alone, so browser assets never bloat server
 * or Worker bundles: `"use client"` modules in the RSC environment, the `ssr`
 * environment when there is no Pages Router (it only renders client
 * components) and, in hybrid App + Pages builds, `ssr` modules that only App
 * Router client references reach. Code the Pages Router runs on the server is
 * rewritten even when it carries `"use client"`, which the Pages Router ignores.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import { parseAst, type ESTree, type Plugin, type ResolvedConfig } from "vite";
import { resolveRuntimeEntryModule } from "../entries/runtime-entry-module.js";
import { safeJsonStringify } from "../server/html.js";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";
import {
  findDirectivePrologueEnd,
  hasDirective,
  IMPORT_META_URL_CANDIDATE_RE,
  isIdentifierNamed,
  isImportMetaUrlNode,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  unwrapExpression,
  walkAst,
} from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

const SERVER_URL_ASSET_PREFIX = "\0vinext-server-url-asset:";
const SERVER_URL_ASSET_BYTES_PREFIX = "\0vinext-server-url-asset-bytes:";
// Asset paths end in extensions (`.json`, `.css`, ...) that Vite's builtin
// plugins claim by id even behind a `\0` prefix, so the generated ids end in
// `.js`. This also names each lazy bytes chunk after its asset.
const SERVER_URL_ASSET_ID_SUFFIX = ".js";
// oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
const SERVER_URL_ASSET_ID_RE = /^\0vinext-server-url-asset(?:-bytes)?:.+\.js$/;

// plugin-rsc's synthetic modules that import the App Router client references
// on the SSR side (`virtual:vite-rsc/client-references` and its groups).
const RSC_CLIENT_REFERENCES_ID_PREFIX = "\0virtual:vite-rsc/client-references";
const URL_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const BINDING_PREFIX = "__vinext_server_url_asset";

type ModuleResolver = (specifier: string, importer: string) => Promise<string | null>;

const WORKER_CONSTRUCTOR_NAMES = new Set(["Worker", "SharedWorker"]);

/** The property of a static member access: `a.b`, `a["b"]` or ``a[`b`]``. */
function staticMemberName(member: ESTree.MemberExpression): string | null {
  if (member.computed) return staticStringValue(unwrapExpression(member.property));
  return member.property.type === "Identifier" ? member.property.name : null;
}

/**
 * `Worker` / `SharedWorker`, bare or as a static member (`worker_threads.Worker`,
 * `globalThis["SharedWorker"]`), through parentheses, casts and `!`.
 */
function isWorkerConstructor(value: ESTree.Node | null | undefined): boolean {
  const target = unwrapExpression(value);
  if (target?.type === "Identifier") return WORKER_CONSTRUCTOR_NAMES.has(target.name);
  if (target?.type !== "MemberExpression") return false;
  const name = staticMemberName(target);
  return name !== null && WORKER_CONSTRUCTOR_NAMES.has(name);
}

/**
 * The script operand of a worker construction — `new Worker(url, ...)` or
 * `Reflect.construct(Worker, [url, ...])` — or `undefined` for other nodes.
 */
function workerScriptOperand(node: ESTree.Node): ESTree.Node | null | undefined {
  if (node.type === "NewExpression") {
    return isWorkerConstructor(node.callee) ? node.arguments[0] : undefined;
  }
  if (node.type !== "CallExpression") return undefined;
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "MemberExpression" ||
    !isIdentifierNamed(unwrapExpression(callee.object), "Reflect") ||
    staticMemberName(callee) !== "construct"
  ) {
    return undefined;
  }
  const [constructor, argumentList] = node.arguments;
  if (!isWorkerConstructor(constructor)) return undefined;
  const list = unwrapExpression(argumentList);
  return list?.type === "ArrayExpression" ? list.elements[0] : undefined;
}

/**
 * Add every `new URL(...)` built anywhere inside a code-loading operand to
 * `target`. Deliberately structural rather than shape-matched, so `url`,
 * `url.href`, `url["href"]`, `String(url)`, `` `${url}` ``, `a ? url : b` and
 * forms not listed here all keep loading a runnable module.
 */
function collectCodeLoadingUrls(
  operand: ESTree.Node | null | undefined,
  target: Set<ESTree.Node>,
): void {
  if (!operand) return;
  walkAst(operand, (node) => {
    if (node.type === "NewExpression" && isIdentifierNamed(node.callee, "URL")) target.add(node);
  });
}

async function isServerUrlAssetFile(filePath: string): Promise<boolean> {
  // `?`/`#` would be read back as a Vite query/hash on the generated ids.
  if (/[?#]/.test(filePath)) return false;
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the first argument of `new URL(specifier, import.meta.url)` in
 * `importer` to an asset file, or `null` when the expression must be left
 * alone (remote/absolute URLs, missing files, script modules).
 *
 * Mirrors Vite's client-side `new URL` asset resolution (`preferRelative`):
 * the URL-relative file wins, and a bare specifier that is not a sibling file
 * falls back to module resolution — the webpack/Turbopack edge behaviour that
 * lets `new URL("my-pkg/data.json", import.meta.url)` load from node_modules.
 */
export async function resolveServerUrlAssetFile(
  specifier: string,
  importer: string,
  resolveModule: ModuleResolver,
): Promise<string | null> {
  if (
    specifier === "" ||
    URL_SCHEME_RE.test(specifier) ||
    specifier.startsWith("/") ||
    specifier.includes("\\") ||
    /[?#]/.test(specifier)
  ) {
    return null;
  }

  let urlRelativePath: string;
  try {
    urlRelativePath = toSlash(fileURLToPath(new URL(specifier, pathToFileURL(importer))));
  } catch {
    return null;
  }
  if (await isServerUrlAssetFile(urlRelativePath)) return urlRelativePath;
  if (/^\.\.?(?:\/|$)/.test(specifier)) return null;

  const resolved = await resolveModule(specifier, importer);
  return resolved !== null && (await isServerUrlAssetFile(resolved)) ? resolved : null;
}

function serverUrlAssetModuleId(prefix: string, assetPath: string): string {
  return `${prefix}${assetPath}${SERVER_URL_ASSET_ID_SUFFIX}`;
}

function serverUrlAssetModuleCode(runtimeModule: string, assetPath: string): string {
  return [
    `import { registerServerUrlAsset } from ${safeJsonStringify(runtimeModule)};`,
    `export default registerServerUrlAsset(${safeJsonStringify(pathToFileURL(assetPath).href)}, () => import(${safeJsonStringify(serverUrlAssetModuleId(SERVER_URL_ASSET_BYTES_PREFIX, assetPath))}));`,
    "",
  ].join("\n");
}

function serverUrlAssetBytesModuleCode(runtimeModule: string, bytes: Buffer): string {
  return [
    `import { decodeServerUrlAsset } from ${safeJsonStringify(runtimeModule)};`,
    `export default decodeServerUrlAsset(${safeJsonStringify(bytes.toString("base64"))});`,
    "",
  ].join("\n");
}

type ModuleGraphInfo = {
  isEntry: boolean;
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
};

/**
 * Modules of a (scanned) SSR graph that only App Router client references
 * reach: everything not reachable from an entry without passing through
 * plugin-rsc's synthetic client-reference branch. The Pages Router imports
 * components directly, so a `"use client"` component shared by both routers,
 * and everything it imports, stays out of the set.
 */
export function collectClientReferenceOnlyModules(options: {
  moduleIds: Iterable<string>;
  getModuleInfo: (id: string) => ModuleGraphInfo | null;
  isClientReferenceBranch: (id: string) => boolean;
}): Set<string> {
  const moduleIds = [...options.moduleIds];
  const pending = moduleIds.filter((id) => options.getModuleInfo(id)?.isEntry === true);
  const serverReachable = new Set<string>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (serverReachable.has(id) || options.isClientReferenceBranch(id)) continue;
    serverReachable.add(id);
    const info = options.getModuleInfo(id);
    if (info) pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
  }
  return new Set(moduleIds.filter((id) => !serverReachable.has(id)));
}

export function createServerUrlAssetsPlugin(
  options: {
    /** App Router with no `pages/` directory; read once environments are created. */
    isAppRouterOnly?: () => boolean;
    /** plugin-rsc's manager when the App Router is enabled. */
    getRscManager?: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
  } = {},
): Plugin {
  const runtimeModule = resolveRuntimeEntryModule("server-url-assets");
  let rscManager: RscPluginManager | undefined;
  // Hybrid App + Pages builds keep the `ssr` environment for the Pages Router,
  // but it also renders App Router client components, whose `new URL` assets
  // belong to the browser build. A `"use client"` directive cannot tell them
  // apart: it does not cover a component's own imports, and the Pages Router
  // runs a component shared with `app/` as ordinary server code. plugin-rsc's
  // SSR scan build (which runs before the real SSR build) supplies the modules
  // that only its client-reference branch reaches. Modules missing from the
  // scan are rewritten, the safe default.
  //
  // Dev has no scan and its module graph only knows the importers seen so far,
  // so a module first reached from a client component could never be rewritten
  // for a Pages route that imports it later. Dev therefore rewrites every `ssr`
  // module, `"use client"` ones included; for relative specifiers the SSR href
  // matches the `file:` URL that dev already produced, and the bytes stay in
  // lazily loaded dev modules.
  let clientReferenceOnlySsrModules: ReadonlySet<string> | undefined;

  return {
    name: "vinext:server-url-assets",

    applyToEnvironment(environment) {
      // Client builds keep Vite's own `new URL` asset handling (public URLs).
      if (environment.config.consumer !== "server") return false;
      // Nitro's environment re-bundles the already-built vinext server outputs.
      // Their project references were rewritten when those outputs were built;
      // any `new URL` left in them points at an emitted file (e.g. the
      // @vercel/og WASM fallback) that must stay relative to the deployed
      // output rather than be pinned to the build directory and inlined again.
      if (environment.name === "nitro") return false;
      // Without a Pages Router, the App Router `ssr` environment only renders
      // client components, which never fetch server assets. Inlining their
      // `new URL` files would only grow the SSR (and Worker) bundle. Route
      // handlers, middleware and server components run in `rsc`.
      return !(environment.name === "ssr" && options.isAppRouterOnly?.() === true);
    },

    async buildStart() {
      if (this.environment.mode !== "build" || options.getRscManager === undefined) return;
      rscManager ??= await options.getRscManager(this.environment.getTopLevelConfig());
      // plugin-rsc scans RSC first, then SSR; a new RSC scan starts a new app build.
      if (rscManager?.isScanBuild && this.environment.name === "rsc") {
        clientReferenceOnlySsrModules = undefined;
      }
    },

    buildEnd(error) {
      if (error || this.environment.name !== "ssr" || !rscManager?.isScanBuild) return;
      clientReferenceOnlySsrModules = collectClientReferenceOnlyModules({
        moduleIds: this.getModuleIds(),
        getModuleInfo: (id) => this.getModuleInfo(id),
        isClientReferenceBranch: (id) => id.startsWith(RSC_CLIENT_REFERENCES_ID_PREFIX),
      });
    },

    resolveId: {
      filter: { id: SERVER_URL_ASSET_ID_RE },
      handler(id) {
        return id;
      },
    },

    load: {
      filter: { id: SERVER_URL_ASSET_ID_RE },
      async handler(id) {
        const idWithoutSuffix = id.slice(0, -SERVER_URL_ASSET_ID_SUFFIX.length);
        if (id.startsWith(SERVER_URL_ASSET_PREFIX)) {
          return serverUrlAssetModuleCode(
            runtimeModule,
            idWithoutSuffix.slice(SERVER_URL_ASSET_PREFIX.length),
          );
        }

        const assetPath = idWithoutSuffix.slice(SERVER_URL_ASSET_BYTES_PREFIX.length);
        // Edits to the asset invalidate the bytes module in dev.
        this.addWatchFile(assetPath);
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(assetPath);
        } catch (error) {
          return this.error(
            `[vinext] Could not read server asset referenced via new URL(..., import.meta.url): ${assetPath} (${String(error)})`,
          );
        }
        return serverUrlAssetBytesModuleCode(runtimeModule, bytes);
      },
    },

    transform: {
      filter: {
        id: {
          include: SCRIPT_MODULE_ID_RE,
          exclude: [VIRTUAL_MODULE_ID_RE, NODE_MODULES_PATH_RE],
        },
        // Native pre-filter. Every rewritable reference has an
        // `import.meta.url` base, so reuse the import-meta-url candidate
        // scanner: it tolerates comments, whitespace and escapes between the
        // tokens (and so any `)` inside them). Deliberately over-inclusive —
        // it matches any `import.meta.url` read; the AST pass below is exact.
        code: IMPORT_META_URL_CANDIDATE_RE,
      },
      async handler(code, id) {
        // plugin-rsc strips scan-build modules down to their imports.
        if (rscManager?.isScanBuild) return null;
        if (clientReferenceOnlySsrModules?.has(id) && this.environment.name === "ssr") return null;
        const importer = toSlash(stripViteModuleQuery(id));
        if (!path.isAbsolute(importer)) return null;

        let ast: ReturnType<typeof parseAst>;
        try {
          ast = parseAst(code, { lang: scriptParserLanguage(importer) ?? "jsx" });
        } catch {
          return null;
        }
        // The RSC environment replaces `"use client"` modules with client
        // references, so their code (and its assets) never runs there. In other
        // server environments the directive is inert for the Pages Router,
        // which runs the module as server code; App Router-only client code in
        // hybrid `ssr` builds is excluded above instead.
        if (this.environment.name === "rsc" && hasDirective(ast, "use client")) return null;

        const references: Array<{ start: number; end: number; specifier: string }> = [];
        // URLs that load code rather than read bytes: worker scripts and
        // dynamic imports must keep resolving to a runnable module, as with
        // webpack (worker dependencies are not asset URLs) and Vite (whose
        // worker plugin claims the same `new Worker(new URL(...))` shape).
        const codeLoadingUrls = new Set<ESTree.Node>();
        walkAst(ast, (node) => {
          // Pre-order: the code load is visited before the URLs inside it.
          if (node.type === "ImportExpression") {
            collectCodeLoadingUrls(node.source, codeLoadingUrls);
          } else {
            collectCodeLoadingUrls(workerScriptOperand(node), codeLoadingUrls);
          }
          if (node.type !== "NewExpression" || !isIdentifierNamed(node.callee, "URL")) return;
          if (codeLoadingUrls.has(node)) return false;
          const [input, base] = node.arguments;
          if (node.arguments.length !== 2 || !input || !base || !isImportMetaUrlNode(base)) return;
          const specifier = staticStringValue(input);
          if (specifier === null) return;
          // Same opt-out as Vite's client-side handling.
          if (code.slice(node.start, input.start).includes("@vite-ignore")) return false;
          references.push({ start: node.start, end: node.end, specifier });
          return false;
        });
        if (references.length === 0) return null;

        const resolveModule: ModuleResolver = async (specifier, from) => {
          try {
            const resolved = await this.resolve(specifier, from, { skipSelf: true });
            if (resolved && !resolved.external) {
              const resolvedPath = toSlash(stripViteModuleQuery(resolved.id));
              if (path.isAbsolute(resolvedPath)) return resolvedPath;
            }
          } catch {}
          // Vite's resolver needs a package.json; Node's (like webpack's) also
          // resolves files from unpackaged node_modules directories.
          try {
            return toSlash(createRequire(from).resolve(specifier));
          } catch {
            return null;
          }
        };

        let bindingPrefix = BINDING_PREFIX;
        while (code.includes(bindingPrefix)) bindingPrefix += "_";

        const output = new MagicString(code);
        const bindings = new Map<string, string>();
        for (const reference of references) {
          const assetPath = await resolveServerUrlAssetFile(
            reference.specifier,
            importer,
            resolveModule,
          );
          if (assetPath === null) continue;
          let binding = bindings.get(assetPath);
          if (binding === undefined) {
            binding = `${bindingPrefix}${bindings.size}`;
            bindings.set(assetPath, binding);
          }
          output.overwrite(reference.start, reference.end, `new URL(${binding})`);
        }
        if (bindings.size === 0) return null;

        const imports = Array.from(
          bindings,
          ([assetPath, binding]) =>
            `import ${binding} from ${safeJsonStringify(serverUrlAssetModuleId(SERVER_URL_ASSET_PREFIX, assetPath))};`,
        ).join("\n");
        const insertAt = findDirectivePrologueEnd(ast);
        output.appendLeft(insertAt, insertAt === 0 ? `${imports}\n` : `\n${imports}\n`);
        return magicStringTransformResult(output);
      },
    },
  };
}
