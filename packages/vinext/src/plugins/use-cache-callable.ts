import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "pathslash";
import { pathToFileURL } from "node:url";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type {
  ModuleExportMeta,
  TransformHoistInlineDirectiveMeta,
} from "@vitejs/plugin-rsc/transforms";
import { parseAstAsync, type Plugin } from "vite";
import { isPathInside, NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { magicStringTransformResult } from "./transform-result.js";

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
  appPageSegmentFunction?: boolean;
  argumentCount?: number;
  serverReferenceId?: string;
};

const PLUGIN_NAME = "vinext:server-function-directives";
const SOURCE_MODULE_ID_RE = /\.(?:tsx?|jsx?|mjs)(?:\?.*)?$/;
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

function isAppPageModule(options: Options, id: string): boolean {
  const appDir = options.getAppDir();
  if (!appDir) return false;
  const modulePath = stripViteModuleQuery(id);
  const moduleFileName = path.basename(modulePath);
  return (
    isPathInside(appDir, modulePath) &&
    path.parse(moduleFileName).name === "page" &&
    options.matchesPageExtension(moduleFileName)
  );
}

function isFunctionNode(node: unknown): boolean {
  const type = (node as { type?: unknown } | null | undefined)?.type;
  return (
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression"
  );
}

/**
 * Exports of an App Router page file that Next.js treats as page segment
 * functions (`$$isPage`, use-cache-wrapper.ts `isPageSegmentFunction`): the
 * page component, plus the page's generateMetadata/generateViewport, which
 * receive the same `{ params, searchParams }` props.
 */
const APP_PAGE_SEGMENT_EXPORT_NAMES = new Set(["default", "generateMetadata", "generateViewport"]);

/**
 * Find the top-level functions a page module exports as page segment
 * functions: a direct `export default function` / `export async function
 * generateMetadata`, or a top-level function referenced by `export default
 * Page` / `export { Page as default }`. Returns the AST nodes themselves so
 * callers can match a hoisted directive's `valueNode` by identity.
 */
function findAppPageSegmentFunctions(ast: Program): Set<object> {
  const functions = new Set<object>();
  const localNames = new Set<string>();
  const addFunctionDeclarator = (
    declarator: { id: { type: string; name?: string }; init?: unknown },
    names: ReadonlySet<string>,
  ) => {
    if (
      declarator.id.type === "Identifier" &&
      declarator.id.name !== undefined &&
      names.has(declarator.id.name) &&
      isFunctionNode(declarator.init)
    ) {
      functions.add(declarator.init as object);
    }
  };

  for (const statement of ast.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      if (isFunctionNode(statement.declaration)) functions.add(statement.declaration);
      else if (statement.declaration.type === "Identifier") {
        localNames.add(statement.declaration.name);
      }
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration") {
      if (declaration.id && APP_PAGE_SEGMENT_EXPORT_NAMES.has(declaration.id.name)) {
        functions.add(declaration);
      }
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        addFunctionDeclarator(declarator, APP_PAGE_SEGMENT_EXPORT_NAMES);
      }
    }
    for (const specifier of statement.specifiers) {
      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      if (APP_PAGE_SEGMENT_EXPORT_NAMES.has(exported) && specifier.local.type === "Identifier") {
        localNames.add(specifier.local.name);
      }
    }
  }
  if (localNames.size === 0) return functions;

  for (const statement of ast.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration") {
      if (declaration.id && localNames.has(declaration.id.name)) functions.add(declaration);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        addFunctionDeclarator(declarator, localNames);
      }
    }
  }
  return functions;
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

function getFunctionDirectiveExportNames(
  transforms: RscTransforms,
  ast: Program,
  directive: string,
): Set<string> {
  const names = new Set<string>();
  for (const group of transforms.scanModuleExports(ast)) {
    const entries =
      group.type === "declaration"
        ? [group.export]
        : group.type === "variable-declaration"
          ? group.declarators.flatMap((declarator) => declarator.exports)
          : group.type === "specifiers"
            ? group.exports
            : group.type === "default"
              ? [{ exportName: "default", meta: group.meta }]
              : [];
    for (const entry of entries) {
      if (hasFunctionDirective(entry.meta, directive)) names.add(entry.exportName);
    }
  }
  return names;
}

function getCacheWrapperOptions(
  appPageSegmentFunction: boolean,
  meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
): CacheWrapperOptions {
  const argumentCount = getArgumentCount(meta);
  return {
    acceptsSecondArgument: acceptsSecondArgument(meta),
    ...(appPageSegmentFunction ? { appPageSegmentFunction: true } : {}),
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
  // Cache functions use React's server-reference transport when they are passed
  // to Client Components or invoked by the Response Store. The upstream RSC
  // plugin's reference key is a public, deterministic module-path hash, so the
  // original export name must not also be the remotely addressable name. A
  // per-plugin secret keeps aliases stable across every environment/build pass
  // in one Vite build without making sibling exports derivable from each other.
  const referenceSecret = randomBytes(32);
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
          exclude: [NODE_MODULES_PATH_RE, RESOLVED_VIRTUAL_MODULE_ID_RE],
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
        const relativeImportId = manager.toRelativeId(reference.importId);
        const secureExportName = (name: string) =>
          `$$vinext_cache_${createHmac("sha256", referenceSecret)
            .update(relativeImportId)
            .update("\0")
            .update(name)
            .digest("hex")}`;
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

          const useServerExportNames = getFunctionDirectiveExportNames(
            transforms,
            ast,
            "use server",
          );
          const result = transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: moduleDirective,
            filter: (name, meta) => {
              if (!shouldTransformModuleExport(name, id, meta)) return false;
              validateModuleExport(transforms, meta);
              return true;
            },
            runtime: (name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(`${reference.referenceKey}#${useServerExportNames.has(name) ? name : secureExportName(name)}`)},$$ReactClient.callServer,undefined,${this.environment.mode === "dev" ? "$$ReactClient.findSourceMapURL" : "undefined"},${JSON.stringify(name)})`,
          });
          if (!result?.output.hasChanged()) {
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }

          manager.serverReferences.replaceClaim(PLUGIN_NAME, id, {
            ...reference,
            exportNames: result.exportNames.map((name) =>
              useServerExportNames.has(name) ? name : secureExportName(name),
            ),
          });
          const runtimeEnvironment = this.environment.name === "client" ? "browser" : "ssr";
          result.output.prepend(
            `import * as $$ReactClient from "@vitejs/plugin-rsc/react/${runtimeEnvironment}";\n`,
          );
          return magicStringTransformResult(result.output, { hires: "boundary", source: id });
        }

        // Next.js passes `$$isPage` to a page component (and the page's
        // generateMetadata/generateViewport) that is a "use cache" function,
        // whether the directive is file-level or inline in the exported
        // function, so both shapes omit searchParams from the cache key.
        const appPageModule = isAppPageModule(options, id);
        const appPageSegmentFunctions =
          appPageModule && !moduleDirective ? findAppPageSegmentFunctions(ast) : undefined;
        const secureExports = new Set<string>();
        const wrap = (
          value: string,
          name: string,
          directiveMatch: RegExpMatchArray,
          meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
          isModuleDirective: boolean,
        ) => {
          const variant = directiveMatch[1] ?? "";
          const secureName = secureExportName(name);
          secureExports.add(secureName);
          const appPageSegmentFunction = isModuleDirective
            ? appPageModule && APP_PAGE_SEGMENT_EXPORT_NAMES.has(name)
            : meta.valueNode !== undefined && appPageSegmentFunctions?.has(meta.valueNode) === true;
          const wrapperOptions = {
            ...getCacheWrapperOptions(appPageSegmentFunction, meta),
            serverReferenceId: `${reference.referenceKey}#${secureName}`,
          };
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
          const secureName = secureExportName(name);
          needsReactServer = true;
          return `(${secureName} = $$VinextReactServer.registerServerReference(${cached}, ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(secureName)}))`;
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
              noExport: true,
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
          exportNames: [...secureExports],
        });
        const importPosition =
          ast.body.find((node) => !("directive" in node))?.start ?? code.length;
        result.output.prependLeft(
          importPosition,
          [
            `import * as $$cacheRuntime from ${JSON.stringify(options.cacheRuntime)};`,
            needsReactServer &&
              `import * as $$VinextReactServer from "@vitejs/plugin-rsc/react/rsc/server";`,
            secureExports.size > 0 && `let ${[...secureExports].join(",")};`,
          ]
            .filter(Boolean)
            .join("\n") + "\n",
        );
        if (secureExports.size > 0) {
          result.output.append(`\nexport { ${[...secureExports].join(",")} };\n`);
        }
        return magicStringTransformResult(result.output, { hires: "boundary", source: id });
      },
    },
  };
}
