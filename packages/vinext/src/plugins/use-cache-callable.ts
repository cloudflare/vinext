import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "pathslash";
import { pathToFileURL } from "node:url";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type {
  ModuleExportMeta,
  TransformHoistInlineDirectiveMeta,
} from "@vitejs/plugin-rsc/transforms";
import type { ESTree, Plugin } from "vite";
import { parseProgramAsync } from "./ast-utils.js";
import { NODE_MODULES_PATH_RE } from "../utils/path.js";
import { magicStringTransformResult } from "./transform-result.js";

type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type Program = ESTree.Program;

type Options = {
  projectRoot: string;
  cacheRuntime: string;
  allowMissingRsc?: boolean;
};

type CacheWrapperOptions = {
  acceptsSecondArgument: boolean;
  argumentCount?: number;
  captureCount?: number;
  serverReferenceId?: string;
};

type BrowserTransformOptions = {
  environmentName: string;
  reference: { referenceKey: string };
  secureExportName: (name: string) => string;
  createReference: (referenceId: string, name: string) => string;
};

type BrowserTransformOutput = NonNullable<
  ReturnType<RscTransforms["transformDirectiveProxyExport"]>
>;

export type UseCacheCallableApi = {
  /**
   * Compile a browser Web Worker module like the client environment does,
   * with the same reference ids, without claiming references.
   */
  transformWorkerModule(
    code: string,
    id: string,
    createReference: BrowserTransformOptions["createReference"],
  ): Promise<BrowserTransformOutput["output"] | undefined>;
};

const PLUGIN_NAME = "vinext:server-function-directives";
export { PLUGIN_NAME as USE_CACHE_PLUGIN_NAME };
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
  meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
): CacheWrapperOptions {
  const argumentCount = getArgumentCount(meta);
  // Like Next.js, a function that closes over values must receive exactly its
  // encrypted captures, bound to its own reference, as the first argument
  // (use-cache-wrapper.ts `boundArgsLength`, encryption.ts `actionId`).
  const captureCount = "bindVars" in meta ? meta.bindVars.length : 0;
  return {
    acceptsSecondArgument: acceptsSecondArgument(meta),
    ...(argumentCount === undefined ? {} : { argumentCount }),
    ...(captureCount === 0 ? {} : { captureCount }),
  };
}

/**
 * Compile a module for a browser graph: module-level cache functions become
 * server references, and inline ones are rejected as in Next.js Client
 * Components. Returns undefined when the module is unchanged.
 */
function transformBrowserModule(
  transforms: RscTransforms,
  code: string,
  ast: Program,
  id: string,
  moduleDirective: string | undefined,
  options: BrowserTransformOptions,
): { output: BrowserTransformOutput["output"]; referenceNames: string[] } | undefined {
  if (!moduleDirective) {
    transforms.transformHoistInlineDirective(code, ast, {
      directive: USE_CACHE_DIRECTIVE_CANDIDATE,
      rejectNonAsyncFunction: true,
      runtime: (_value, _name, meta) => {
        matchUseCacheDirective(meta.directiveMatch[0]);
        throw new Error(
          `It is not allowed to define inline "use cache" annotated functions in Client Components. Export them from a separate file with a module-level "use cache" or "use server" directive, or pass them down through props from a Server Component. (${options.environmentName}: ${id})`,
        );
      },
    });
    return;
  }

  const useServerExportNames = getFunctionDirectiveExportNames(transforms, ast, "use server");
  const referenceName = (name: string) =>
    useServerExportNames.has(name) ? name : options.secureExportName(name);
  const result = transforms.transformDirectiveProxyExport(ast, {
    code,
    directive: moduleDirective,
    filter: (name, meta) => {
      if (!shouldTransformModuleExport(name, id, meta)) return false;
      validateModuleExport(transforms, meta);
      return true;
    },
    runtime: (name) =>
      options.createReference(`${options.reference.referenceKey}#${referenceName(name)}`, name),
  });
  if (!result?.output.hasChanged()) return;
  return { output: result.output, referenceNames: result.exportNames.map(referenceName) };
}

export async function createUseCacheCallablePlugin(
  options: Options,
): Promise<Plugin<UseCacheCallableApi>> {
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

  async function analyzeModule(manager: RscPluginManager, code: string, id: string) {
    const ast = await parseProgramAsync(code);
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
    return { ast, moduleDirective, useServerBoundary, reference, secureExportName };
  }

  return {
    name: PLUGIN_NAME,
    api: {
      async transformWorkerModule(code, id, createReference) {
        if (!code.includes("use cache")) return;
        if (!manager) {
          // Like the worker "use server" transform, fail rather than ship the
          // module body.
          if (findModuleUseCacheDirective(await parseProgramAsync(code))) {
            throw new Error(
              'vinext: cannot compile a "use cache" module in a Web Worker without @vitejs/plugin-rsc.',
            );
          }
          return;
        }
        const { ast, moduleDirective, useServerBoundary, reference, secureExportName } =
          await analyzeModule(manager, code, id);
        if (useServerBoundary) return;
        return transformBrowserModule(transforms, code, ast, id, moduleDirective, {
          environmentName: "worker",
          reference,
          secureExportName,
          createReference,
        })?.output;
      },
    },
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

        const { ast, moduleDirective, useServerBoundary, reference, secureExportName } =
          await analyzeModule(manager, code, id);
        const isRsc = this.environment.name === "rsc";

        if (!isRsc) {
          if (useServerBoundary) {
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }
          const result = transformBrowserModule(transforms, code, ast, id, moduleDirective, {
            environmentName: this.environment.name,
            reference,
            secureExportName,
            createReference: (referenceId, name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(referenceId)},$$ReactClient.callServer,undefined,${this.environment.mode === "dev" ? "$$ReactClient.findSourceMapURL" : "undefined"},${JSON.stringify(name)})`,
          });
          if (!result) {
            manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
            return;
          }

          manager.serverReferences.replaceClaim(PLUGIN_NAME, id, {
            ...reference,
            exportNames: result.referenceNames,
          });
          const runtimeEnvironment = this.environment.name === "client" ? "browser" : "ssr";
          result.output.prepend(
            `import * as $$ReactClient from "@vitejs/plugin-rsc/react/${runtimeEnvironment}";\n`,
          );
          return magicStringTransformResult(result.output, { hires: "boundary", source: id });
        }

        // Page semantics (omitting searchParams) are not decided here: like
        // Next.js, the page and page metadata call sites pass `$$isPage` to a
        // cache function, wherever it is defined (see cache-runtime.ts).
        const secureExports = new Set<string>();
        const wrap = (
          value: string,
          name: string,
          directiveMatch: RegExpMatchArray,
          meta: Pick<ModuleExportMeta, "valueNode"> | TransformHoistInlineDirectiveMeta,
        ) => {
          const variant = directiveMatch[1] ?? "";
          const secureName = secureExportName(name);
          secureExports.add(secureName);
          const wrapperOptions = {
            ...getCacheWrapperOptions(meta),
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
        ) => {
          const cached = wrap(value, name, directiveMatch, meta);
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
                runtime(value, name, matchUseCacheDirective(moduleDirective), meta),
            })
          : transforms.transformHoistInlineDirective(code, ast, {
              directive: USE_CACHE_DIRECTIVE_CANDIDATE,
              rejectNonAsyncFunction: true,
              hoistRuntime: true,
              noExport: true,
              runtime: (value, name, meta) =>
                runtime(value, name, matchUseCacheDirective(meta.directiveMatch[0]), meta),
              encode: (value, name?: string) => {
                // Older plugin-rsc releases pass neither `name` nor `meta.bindVars`.
                if (name === undefined) {
                  throw new Error(
                    'vinext: inline "use cache" functions require @vitejs/plugin-rsc 0.5.37 or newer.',
                  );
                }
                const referenceId = `${reference.referenceKey}#${secureExportName(name)}`;
                return `$$cacheRuntime.encryptCacheCaptures(${JSON.stringify(referenceId)}, ${value})`;
              },
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
