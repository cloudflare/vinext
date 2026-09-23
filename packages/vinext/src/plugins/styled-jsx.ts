import { createRequire } from "node:module";
import path from "pathslash";
import { pathToFileURL } from "node:url";
import {
  isRunnableDevEnvironment,
  parseAst,
  type DevEnvironment,
  type Environment,
  type Plugin,
} from "vite";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { SCRIPT_MODULE_ID_RE, walkAst } from "./ast-utils.js";

type NextSwcModule = {
  loadBindings(): Promise<unknown>;
  transform(
    source: string,
    options: Record<string, unknown>,
  ): Promise<{ code: string; map?: string }>;
};

type StyledJsxPluginOptions = {
  importModule?: (url: string) => Promise<NextSwcModule>;
};

/**
 * Server-only module that hands styled-jsx's own `StyleRegistry` and
 * `createStyleRegistry` to `vinext/shims/styled-jsx-registry`, so Pages Router
 * SSR can render `<style jsx>` rules into the document the way Next.js's
 * `render.tsx` does. Only modules this plugin compiles import it, which keeps
 * styled-jsx out of server bundles for apps that never use it.
 */
const STYLED_JSX_SSR_REGISTRY_ID = "virtual:vinext-styled-jsx-ssr-registry";
const RESOLVED_STYLED_JSX_SSR_REGISTRY_ID = "\0" + STYLED_JSX_SSR_REGISTRY_ID;
const STYLED_JSX_RESOLVE_ID_RE = /^(?:styled-jsx(?:\/.*)?|virtual:vinext-styled-jsx-ssr-registry)$/;
const STYLED_JSX_STYLE_IMPORT_RE = /["']styled-jsx\/style["']/;
const STYLED_JSX_SSR_REGISTRY_CODE = `import * as styledJsx from "styled-jsx";
import { registerStyledJsxRuntime } from "vinext/shims/styled-jsx-registry";
const runtime = typeof styledJsx.StyleRegistry === "function" ? styledJsx : styledJsx.default;
registerStyledJsxRuntime({
  StyleRegistry: runtime.StyleRegistry,
  createStyleRegistry: runtime.createStyleRegistry,
});
`;
/** Prefix for dev-only ESM facades over natively required styled-jsx files. */
const STYLED_JSX_NODE_MODULE_PREFIX = "\0vinext-styled-jsx-node:";
const STYLED_JSX_LOAD_RE = /^\0(?:virtual:vinext-styled-jsx-ssr-registry$|vinext-styled-jsx-node:)/;
const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;

function hasStyledJsxTag(source: string, id: string): boolean {
  const cleanId = stripViteModuleQuery(id);
  const extension = path.extname(cleanId);
  const lang = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : "tsx";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(source, { lang });
  } catch {
    return false;
  }

  let found = false;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      if (name.type === "JSXIdentifier" && name.name === "style") {
        if (
          node.attributes.some((attribute) => {
            if (attribute.type !== "JSXAttribute") return false;
            return attribute.name.type === "JSXIdentifier" && attribute.name.name === "jsx";
          })
        ) {
          found = true;
          return false;
        }
      }
    }
  });
  return found;
}

/**
 * Pages Router SSR (and App Router SSR of client components) runs in server
 * environments other than `rsc`. RSC cannot render styled-jsx (it imports
 * `client-only`), so the registration import is skipped there.
 */
function shouldRegisterSsrRuntime(environment: Environment | undefined): boolean {
  return environment?.config.consumer === "server" && environment.name !== "rsc";
}

/**
 * styled-jsx only ships CommonJS. Resolving it from Next's dependency graph
 * (below) bypasses Vite's resolver, and with it the dependency optimizer that
 * normally converts CommonJS for dev — so the browser, the Workers runner and
 * the Pages Router SSR runner all received raw `module.exports` code. Register
 * the resolved file with a discovering optimizer, exactly as Vite's own
 * `vite:pre-alias` plugin does for aliased dependencies.
 */
function registerOptimizedDependency(
  environment: Environment | undefined,
  source: string,
  resolved: string,
  scan: boolean | undefined,
): string | null {
  if (scan || environment?.mode !== "dev") return null;
  const depsOptimizer = (environment as DevEnvironment).depsOptimizer;
  if (!depsOptimizer || depsOptimizer.options.noDiscovery) return null;
  const exclude = depsOptimizer.options.exclude ?? [];
  if (exclude.includes("styled-jsx") || exclude.includes(source)) return null;
  return depsOptimizer.getOptimizedDepId(depsOptimizer.registerMissingImport(source, resolved));
}

/**
 * Server environments do not discover dependencies. App Router dev still runs
 * styled-jsx through `@vitejs/plugin-rsc`'s CommonJS transform, but the Pages
 * Router SSR runner has no such transform. When the runner lives in this Node
 * process and already loads React natively, require styled-jsx natively too so
 * it shares that React instance with the page being rendered.
 */
function shouldLoadNatively(environment: Environment | undefined): boolean {
  if (
    !environment ||
    environment.mode !== "dev" ||
    environment.config.consumer !== "server" ||
    !isRunnableDevEnvironment(environment)
  ) {
    return false;
  }
  const external = environment.config.resolve.external;
  return external === true || (Array.isArray(external) && external.includes("react"));
}

function createNativeModuleFacade(file: string): string {
  const require = createRequire(file);
  const loaded: unknown = require(file);
  const exportNames =
    (typeof loaded === "object" && loaded !== null) || typeof loaded === "function"
      ? Object.keys(loaded).filter((name) => name !== "default" && JS_IDENTIFIER_RE.test(name))
      : [];
  const fileLiteral = JSON.stringify(file);
  return [
    `import { createRequire } from "node:module";`,
    `const mod = createRequire(${fileLiteral})(${fileLiteral});`,
    `export default mod;`,
    ...exportNames.map((name) => `export const ${name} = mod.${name};`),
    "",
  ].join("\n");
}

function createProjectRequire(projectRoot: string) {
  return createRequire(path.join(projectRoot, "package.json"));
}

function resolveNextRequire(projectRoot: string): NodeJS.Require | null {
  try {
    const projectRequire = createProjectRequire(projectRoot);
    return createRequire(projectRequire.resolve("next/package.json"));
  } catch {
    return null;
  }
}

function parserOptions(id: string): Record<string, unknown> {
  const extension = path.extname(stripViteModuleQuery(id));
  if (extension === ".ts" || extension === ".tsx") {
    return { syntax: "typescript", tsx: extension === ".tsx", decorators: true };
  }
  return { syntax: "ecmascript", jsx: true };
}

export function createStyledJsxPlugin(
  initialProjectRoot: string,
  options: StyledJsxPluginOptions = {},
): Plugin {
  let projectRoot = initialProjectRoot;
  let development = false;
  let nextRequire: NodeJS.Require | null | undefined;
  let compilerPromise: Promise<NextSwcModule> | null = null;
  const importModule = options.importModule ?? ((url: string) => import(url));

  function getNextRequire(): NodeJS.Require | null {
    nextRequire ??= resolveNextRequire(projectRoot);
    return nextRequire;
  }

  async function getCompiler(): Promise<NextSwcModule> {
    if (!compilerPromise) {
      const requireFromNext = getNextRequire();
      if (!requireFromNext) {
        throw new Error(
          "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
        );
      }
      const compilerPath = requireFromNext.resolve("next/dist/build/swc");
      compilerPromise = importModule(pathToFileURL(compilerPath).href).then(async (compiler) => {
        await compiler.loadBindings();
        return compiler;
      });
    }
    return compilerPromise;
  }

  function resolveStyledJsx(source: string): string | null {
    try {
      return getNextRequire()?.resolve(source) ?? null;
    } catch {}

    try {
      return createProjectRequire(projectRoot).resolve(source);
    } catch {
      return null;
    }
  }

  return {
    name: "vinext:styled-jsx",
    enforce: "pre",
    configResolved(config) {
      development = config.command === "serve";
      if (config.root !== projectRoot) {
        projectRoot = config.root;
        nextRequire = undefined;
        compilerPromise = null;
      }
    },
    resolveId: {
      filter: { id: STYLED_JSX_RESOLVE_ID_RE },
      handler(source, _importer, resolveOptions) {
        if (source === STYLED_JSX_SSR_REGISTRY_ID) return RESOLVED_STYLED_JSX_SSR_REGISTRY_ID;
        const resolved = resolveStyledJsx(source);
        if (!resolved) return null;
        const environment = this?.environment;
        // Vite passes `scan` while crawling for dependencies; it is not part
        // of the public resolveId options type.
        const scan = (resolveOptions as { scan?: boolean } | undefined)?.scan;
        const optimized = registerOptimizedDependency(environment, source, resolved, scan);
        if (optimized) return optimized;
        if (shouldLoadNatively(environment)) return STYLED_JSX_NODE_MODULE_PREFIX + resolved;
        return resolved;
      },
    },
    load: {
      filter: { id: STYLED_JSX_LOAD_RE },
      handler(id) {
        if (id === RESOLVED_STYLED_JSX_SSR_REGISTRY_ID) return STYLED_JSX_SSR_REGISTRY_CODE;
        return createNativeModuleFacade(id.slice(STYLED_JSX_NODE_MODULE_PREFIX.length));
      },
    },
    transform: {
      filter: {
        id: {
          include: SCRIPT_MODULE_ID_RE,
          exclude: NODE_MODULES_PATH_RE,
        },
        code: STYLED_JSX_SOURCE_RE,
      },
      async handler(source, id) {
        if (NODE_MODULES_PATH_RE.test(stripViteModuleQuery(id))) return null;
        const hasStyledJsxCss = STYLED_JSX_CSS_RE.test(source);
        const hasStyledJsxElement = !hasStyledJsxCss && hasStyledJsxTag(source, id);
        if (!hasStyledJsxCss && !hasStyledJsxElement) return null;
        if (!getNextRequire()) {
          throw new Error(
            "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
          );
        }
        const compiler = await getCompiler();
        const result = await compiler.transform(source, {
          filename: stripViteModuleQuery(id),
          sourceMaps: true,
          module: { type: "es6" },
          // Next's compiler strips getServerSideProps/getStaticProps unless
          // told otherwise; Next.js itself disables that for server compiles.
          // vinext's strip-server-exports plugin owns client-side stripping,
          // so keep data-fetching exports intact in every environment.
          disableNextSsg: true,
          styledJsx: { useLightningcss: false },
          jsc: {
            parser: parserOptions(id),
            transform: {
              react: {
                runtime: "automatic",
                development,
                useBuiltins: true,
              },
              optimizer: { simplify: false },
            },
          },
        });
        // Appended (not prepended) so the compiler's source map stays aligned;
        // ES imports are hoisted, so registration still runs before any render.
        const code =
          shouldRegisterSsrRuntime(this?.environment) &&
          STYLED_JSX_STYLE_IMPORT_RE.test(result.code)
            ? `${result.code}\nimport ${JSON.stringify(STYLED_JSX_SSR_REGISTRY_ID)};\n`
            : result.code;
        return { code, map: result.map ?? null };
      },
    },
  };
}
