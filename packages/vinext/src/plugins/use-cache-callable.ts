import { createRequire } from "node:module";
import path from "pathslash";
import { pathToFileURL } from "node:url";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type {
  ModuleExportMeta,
  TransformHoistInlineDirectiveMeta,
} from "@vitejs/plugin-rsc/transforms";
import { parseAstAsync, type Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type Program = Awaited<ReturnType<typeof parseAstAsync>>;

type Options = {
  projectRoot: string;
  cacheRuntime: string;
  getAppDir: () => string | undefined;
  matchesPageExtension: (fileName: string) => boolean;
  allowMissingRsc?: boolean;
};

type CacheWrapperOptions = {
  acceptsSecondArgument: boolean;
  appPageDefaultExport?: boolean;
  argumentCount?: number;
};

const PLUGIN_NAME = "vinext:server-function-directives";
const SOURCE_MODULE_ID_RE = /\.(?:tsx?|jsx?|mjs)(?:\?.*)?$/;
const DEPENDENCY_MODULE_ID_RE = /[\\/]node_modules[\\/]/;
const RESOLVED_VIRTUAL_MODULE_ID_RE = new RegExp(`^${String.fromCharCode(0)}`);
const USE_CACHE_DIRECTIVE = /^use cache(?:: ([^\s].*))?$/;
const USE_CACHE_DIRECTIVE_CANDIDATE = /^use cache.*$/;

function resolvePluginRscModule(projectRoot: string, specifier: string): string {
  try {
    return createRequire(path.join(projectRoot, "package.json")).resolve(specifier);
  } catch {}

  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    throw new Error(`vinext: Installed @vitejs/plugin-rsc does not expose ${specifier}.`);
  }
}

function matchUseCacheDirective(directive: string): RegExpMatchArray {
  const match = directive.match(USE_CACHE_DIRECTIVE);
  if (match) return match;

  const cacheKind = directive.includes(":")
    ? directive.slice(directive.indexOf(":") + 1).trim()
    : directive.slice("use cache".length).trim();
  const expected = cacheKind ? `use cache: ${cacheKind}` : "use cache";
  throw new Error(
    `Invalid cache directive ${JSON.stringify(directive)}. Did you mean ${JSON.stringify(expected)}?`,
  );
}

function findModuleUseCacheDirective(ast: Program): string | undefined {
  for (const statement of ast.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      !("directive" in statement) ||
      typeof statement.directive !== "string"
    ) {
      break;
    }
    if (statement.directive.startsWith("use cache")) {
      return matchUseCacheDirective(statement.directive)[0];
    }
  }
}

function getArgumentCount(
  meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
): number | undefined {
  const node = meta.valueNode;
  if (
    node?.type !== "FunctionDeclaration" &&
    node?.type !== "FunctionExpression" &&
    node?.type !== "ArrowFunctionExpression"
  ) {
    return;
  }
  return node.params.at(-1)?.type === "RestElement" ? undefined : node.params.length;
}

function acceptsSecondArgument(
  meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
): boolean {
  const node = meta.valueNode;
  if (
    node?.type !== "FunctionDeclaration" &&
    node?.type !== "FunctionExpression" &&
    node?.type !== "ArrowFunctionExpression"
  ) {
    return true;
  }
  return (
    node.params.length >= 2 || node.params.some((parameter) => parameter.type === "RestElement")
  );
}

function isInsideDirectory(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isAppPageDefaultExport(
  options: Options,
  id: string,
  name: string,
  isModuleDirective: boolean,
): boolean {
  const appDir = options.getAppDir();
  if (!isModuleDirective || name !== "default" || !appDir) return false;
  const modulePath = stripViteModuleQuery(id);
  const moduleFileName = path.basename(modulePath);
  return (
    isInsideDirectory(appDir, modulePath) &&
    path.parse(moduleFileName).name === "page" &&
    options.matchesPageExtension(moduleFileName)
  );
}

function shouldTransformModuleExport(name: string, id: string, meta: ModuleExportMeta): boolean {
  if (
    meta.isFunction === false &&
    ((name !== "default" && meta.valueNode?.type === "Literal") ||
      meta.valueNode?.type === "ObjectExpression" ||
      meta.valueNode?.type === "ArrayExpression")
  ) {
    return false;
  }
  if (/\/(layout|template)\.(tsx?|jsx?|mjs)$/.test(id) && name === "default") return false;
  return true;
}

function validateModuleExport(transforms: RscTransforms, meta: ModuleExportMeta): void {
  if (!meta.valueNode) return;
  if (
    meta.isFunction !== false &&
    (meta.valueNode.type === "ObjectExpression" || meta.valueNode.type === "ArrayExpression")
  ) {
    return;
  }
  transforms.validateNonAsyncFunction({ rejectNonAsyncFunction: true }, meta.valueNode);
}

function hasFunctionDirective(
  meta: Pick<ModuleExportMeta, "valueNode">,
  directive: string,
): boolean {
  const node = meta.valueNode;
  if (
    (node?.type !== "FunctionDeclaration" &&
      node?.type !== "FunctionExpression" &&
      node?.type !== "ArrowFunctionExpression") ||
    node.body.type !== "BlockStatement"
  ) {
    return false;
  }
  return node.body.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      "directive" in statement &&
      statement.directive === directive,
  );
}

function getCacheWrapperOptions(
  options: Options,
  id: string,
  name: string,
  isModuleDirective: boolean,
  meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
): CacheWrapperOptions {
  const argumentCount = getArgumentCount(meta);
  return {
    acceptsSecondArgument: acceptsSecondArgument(meta),
    ...(isAppPageDefaultExport(options, id, name, isModuleDirective)
      ? { appPageDefaultExport: true }
      : {}),
    ...(argumentCount === undefined ? {} : { argumentCount }),
  };
}

export async function createUseCacheCallablePlugin(options: Options): Promise<Plugin> {
  const rscModulePath = resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc");
  const transformsPath = resolvePluginRscModule(
    options.projectRoot,
    "@vitejs/plugin-rsc/transforms",
  );
  const rscModule: typeof import("@vitejs/plugin-rsc") = await import(
    pathToFileURL(rscModulePath).href
  );
  const transforms: RscTransforms = await import(pathToFileURL(transformsPath).href);
  let manager: RscPluginManager | undefined;

  return {
    name: PLUGIN_NAME,
    configResolved(config) {
      const pluginApi = rscModule.getPluginApi(config);
      const hasRscPlugin = config.plugins.some((plugin) => plugin.name === "rsc");
      if (!pluginApi && options.allowMissingRsc && !hasRscPlugin) return;
      if (!pluginApi?.manager.serverReferences) {
        throw new Error("vinext: callable use cache requires @vitejs/plugin-rsc 0.5.34 or newer.");
      }
      if (options.allowMissingRsc) {
        const useCacheIndex = config.plugins.findIndex((plugin) => plugin.name === PLUGIN_NAME);
        const useServerIndex = config.plugins.findIndex(
          (plugin) => plugin.name === "rsc:use-server",
        );
        if (useServerIndex !== -1 && useCacheIndex > useServerIndex) {
          throw new Error(
            "vinext: when configuring @vitejs/plugin-rsc manually, vinext({ rsc: false }) must appear before rsc() in the Vite plugins array.",
          );
        }
      }
      manager = pluginApi.manager;
    },
    transform: {
      filter: {
        id: {
          include: SOURCE_MODULE_ID_RE,
          exclude: [DEPENDENCY_MODULE_ID_RE, RESOLVED_VIRTUAL_MODULE_ID_RE],
        },
      },
      async handler(code, id) {
        if (!manager) return;
        if (!code.includes("use cache")) {
          manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
          return;
        }

        const ast = await parseAstAsync(code);
        const moduleDirective = findModuleUseCacheDirective(ast);
        const useServerBoundary = transforms.hasDirective(ast.body, "use server");
        if (moduleDirective && useServerBoundary) {
          throw new Error(
            `A module cannot contain both ${JSON.stringify(moduleDirective)} and "use server" directives.`,
          );
        }

        const reference = manager.serverReferences.resolve(id, "rsc");
        const isRsc = this.environment.name === "rsc";

        if (!isRsc) {
          if (useServerBoundary) {
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }
          if (!moduleDirective) {
            transforms.transformHoistInlineDirective(code, ast, {
              directive: USE_CACHE_DIRECTIVE_CANDIDATE,
              rejectNonAsyncFunction: true,
              runtime: (_value, _name, meta) => {
                matchUseCacheDirective(meta.directiveMatch[0]);
                throw new Error(
                  `It is not allowed to define inline "use cache" annotated functions in Client Components. Export them from a separate file with a module-level "use cache" or "use server" directive, or pass them down through props from a Server Component. (${this.environment.name}: ${id})`,
                );
              },
            });
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }

          const result = transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: moduleDirective,
            filter: (name, meta) => {
              if (!shouldTransformModuleExport(name, id, meta)) return false;
              validateModuleExport(transforms, meta);
              return true;
            },
            runtime: (name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(`${reference.referenceKey}#${name}`)},$$ReactClient.callServer,undefined,${this.environment.mode === "dev" ? "$$ReactClient.findSourceMapURL" : "undefined"},${JSON.stringify(name)})`,
          });
          if (!result?.output.hasChanged()) {
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }

          manager.serverReferences.replaceClaim(PLUGIN_NAME, id, {
            ...reference,
            exportNames: result.exportNames,
          });
          const runtimeEnvironment = this.environment.name === "client" ? "browser" : "ssr";
          result.output.prepend(
            `import * as $$ReactClient from "@vitejs/plugin-rsc/react/${runtimeEnvironment}";\n`,
          );
          return {
            code: result.output.toString(),
            map: result.output.generateMap({ hires: "boundary", source: id }),
          };
        }

        const wrap = (
          value: string,
          name: string,
          directiveMatch: RegExpMatchArray,
          meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
          isModuleDirective: boolean,
        ) => {
          const variant = directiveMatch[1] ?? "";
          const wrapperOptions = getCacheWrapperOptions(options, id, name, isModuleDirective, meta);
          return `$$cacheRuntime.registerCachedFunction(${value}, ${JSON.stringify(`${id}:${name}`)}, ${JSON.stringify(variant)}, ${JSON.stringify(wrapperOptions)})`;
        };
        let needsReactServer = false;
        const runtime = (
          value: string,
          name: string,
          directiveMatch: RegExpMatchArray,
          meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
          isModuleDirective: boolean,
        ) => {
          const cached = wrap(value, name, directiveMatch, meta, isModuleDirective);
          needsReactServer = true;
          return `$$VinextReactServer.registerServerReference(${cached}, ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(name)})`;
        };

        const result = moduleDirective
          ? transforms.transformWrapExport(code, ast, {
              filter: (name, meta) => {
                if (
                  hasFunctionDirective(meta, "use server") ||
                  !shouldTransformModuleExport(name, id, meta)
                ) {
                  return false;
                }
                validateModuleExport(transforms, meta);
                return true;
              },
              runtime: (value, name, meta) =>
                runtime(value, name, matchUseCacheDirective(moduleDirective), meta, true),
            })
          : transforms.transformHoistInlineDirective(code, ast, {
              directive: USE_CACHE_DIRECTIVE_CANDIDATE,
              rejectNonAsyncFunction: true,
              hoistRuntime: true,
              runtime: (value, name, meta) =>
                runtime(value, name, matchUseCacheDirective(meta.directiveMatch[0]), meta, false),
              encode: (value) => `$$cacheRuntime.encryptCacheCaptures(${value})`,
              decode: (value) => value,
            });
        if (!result.output.hasChanged()) {
          manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
          return;
        }

        manager.serverReferences.replaceClaim(PLUGIN_NAME, id, {
          ...reference,
          exportNames: "names" in result ? result.names : result.exportNames,
        });
        const importPosition =
          ast.body.find((node) => !("directive" in node))?.start ?? code.length;
        result.output.prependLeft(
          importPosition,
          [
            `import * as $$cacheRuntime from ${JSON.stringify(options.cacheRuntime)};`,
            needsReactServer &&
              `import * as $$VinextReactServer from "@vitejs/plugin-rsc/react/rsc/server";`,
          ]
            .filter(Boolean)
            .join("\n") + "\n",
        );
        return {
          code: result.output.toString(),
          map: result.output.generateMap({ hires: "boundary", source: id }),
        };
      },
    },
  };
}
