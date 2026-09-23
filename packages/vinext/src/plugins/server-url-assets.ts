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
 * literal resolves to an existing non-script file, so worker scripts,
 * runtime-computed URLs and remote URLs keep their current behaviour.
 * Client code is left alone: `"use client"` modules, and the App Router `ssr`
 * environment when there is no Pages Router (it only renders client
 * components), so browser assets never bloat server or Worker bundles.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";
import { resolveRuntimeEntryModule } from "../entries/runtime-entry-module.js";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";
import {
  findDirectivePrologueEnd,
  hasDirective,
  isIdentifierNamed,
  isImportMetaUrlNode,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
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

// Native pre-filter: a `new URL(` call whose argument list mentions
// import.meta.url before the first `)` outside a string literal. String
// literals are skipped whole, so file names such as "./Inter (Bold).ttf" still
// match; every alternative starts with a different character, so matching does
// not backtrack between them. Deliberately over-inclusive; the AST pass below
// is exact.
const NEW_URL_IMPORT_META_URL_RE =
  /\bnew\s+URL\s*\((?:[^)"'`]|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)*?\bimport\.meta\.url\b/;
const URL_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const BINDING_PREFIX = "__vinext_server_url_asset";

type ModuleResolver = (specifier: string, importer: string) => Promise<string | null>;

async function isServerUrlAssetFile(filePath: string): Promise<boolean> {
  // Script targets are code, not assets: `new Worker(new URL("./w.js", ...))`
  // and friends must keep resolving to a runnable module.
  if (scriptParserLanguage(filePath) !== null) return false;
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
    `import { registerServerUrlAsset } from ${JSON.stringify(runtimeModule)};`,
    `export default registerServerUrlAsset(${JSON.stringify(pathToFileURL(assetPath).href)}, () => import(${JSON.stringify(serverUrlAssetModuleId(SERVER_URL_ASSET_BYTES_PREFIX, assetPath))}));`,
    "",
  ].join("\n");
}

function serverUrlAssetBytesModuleCode(runtimeModule: string, bytes: Buffer): string {
  return [
    `import { decodeServerUrlAsset } from ${JSON.stringify(runtimeModule)};`,
    `export default decodeServerUrlAsset(${JSON.stringify(bytes.toString("base64"))});`,
    "",
  ].join("\n");
}

export function createServerUrlAssetsPlugin(
  options: {
    /** App Router with no `pages/` directory; read once environments are created. */
    isAppRouterOnly?: () => boolean;
  } = {},
): Plugin {
  const runtimeModule = resolveRuntimeEntryModule("server-url-assets");

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
        code: NEW_URL_IMPORT_META_URL_RE,
      },
      async handler(code, id) {
        const importer = toSlash(stripViteModuleQuery(id));
        if (!path.isAbsolute(importer)) return null;

        let ast: ReturnType<typeof parseAst>;
        try {
          ast = parseAst(code, { lang: scriptParserLanguage(importer) ?? "jsx" });
        } catch {
          return null;
        }
        // Client components also render in server environments (hybrid
        // App + Pages builds keep `ssr`); like the App Router `ssr` skip, their
        // assets are for the browser, so leave them to the client build.
        if (hasDirective(ast, "use client")) return null;

        const references: Array<{ start: number; end: number; specifier: string }> = [];
        walkAst(ast, (node) => {
          if (node.type !== "NewExpression" || !isIdentifierNamed(node.callee, "URL")) return;
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
            `import ${binding} from ${JSON.stringify(serverUrlAssetModuleId(SERVER_URL_ASSET_PREFIX, assetPath))};`,
        ).join("\n");
        const insertAt = findDirectivePrologueEnd(ast);
        output.appendLeft(insertAt, insertAt === 0 ? `${imports}\n` : `\n${imports}\n`);
        return magicStringTransformResult(output);
      },
    },
  };
}
