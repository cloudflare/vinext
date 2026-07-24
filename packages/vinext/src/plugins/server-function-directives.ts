import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { SourceMap } from "magic-string";
import type { Plugin, Rollup } from "vite";
import { parseAstAsync, transformWithOxc } from "vite";
import { isUnknownRecord } from "../utils/record.js";
import { escapeRegExp } from "../utils/regex.js";

type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type Program = Parameters<RscTransforms["transformDirectiveProxyExport"]>[0];
type ProgramExpressionStatement = Extract<Program["body"][number], { type: "ExpressionStatement" }>;
type StringDirective = Extract<ProgramExpressionStatement["expression"], { type: "Literal" }> & {
  value: string;
  start: number;
  end: number;
};
type ExportFilter = NonNullable<Parameters<RscTransforms["transformWrapExport"]>[2]["filter"]>;
type ExportMeta = Parameters<ExportFilter>[1];
type FunctionParameters = NonNullable<ExportMeta["parameters"]>;

export type ServerFunctionDirectiveContext = {
  value: string;
  name: string;
  id: string;
  directiveMatch: RegExpMatchArray;
  location: "inline" | "module";
  hasBoundArgs: boolean;
  parameters?: FunctionParameters;
  runtime?: string;
  meta?: ExportMeta;
};

type ServerFunctionDirective = {
  directive: string | RegExp;
  test?: (code: string) => boolean;
  filter?: (id: string) => boolean;
  validate?: (context: { id: string; directive: string; location: "inline" | "module" }) => void;
  rejectNonAsyncFunction?: boolean;
  rejectNonAsyncModule?: boolean;
  runtime?: string;
  wrap: (context: ServerFunctionDirectiveContext) => string;
  filterExport?: (context: { name: string; id: string; meta: ExportMeta }) => boolean;
  clientError?: (context: { id: string; environment: string }) => string;
};

type Options = {
  projectRoot: string;
  definitions: ServerFunctionDirective[];
  serverEnvironmentName: string;
  browserEnvironmentName: string;
};

const SERVER_FUNCTION_DIRECTIVE_MARKER = "/* __vinext_server_function_directives__ */";
const SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME = "vinext:server-function-directives";
const USE_SERVER_PLUGIN_NAME = "rsc:use-server";

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

async function parseProgram(code: string): Promise<Program> {
  return (await parseAstAsync(code)) as unknown as Program;
}

function matchDirective(value: string, directive: string | RegExp): RegExpMatchArray | undefined {
  const pattern =
    typeof directive === "string"
      ? new RegExp(`^${escapeRegExp(directive)}$`)
      : new RegExp(directive.source, directive.flags);
  pattern.lastIndex = 0;
  return value.match(pattern) ?? undefined;
}

function isStringLiteral(value: unknown): value is StringDirective {
  return (
    isUnknownRecord(value) &&
    value.type === "Literal" &&
    typeof value.value === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
}

function isExpressionStatement(
  value: unknown,
): value is Record<string, unknown> & { type: "ExpressionStatement"; expression: unknown } {
  return isUnknownRecord(value) && value.type === "ExpressionStatement" && "expression" in value;
}

function isBlockStatement(
  value: unknown,
): value is Record<string, unknown> & { type: "BlockStatement"; body: unknown[] } {
  return isUnknownRecord(value) && value.type === "BlockStatement" && Array.isArray(value.body);
}

function findModuleDirective(
  ast: Program,
  directive: string | RegExp,
): StringDirective | undefined {
  for (const node of ast.body) {
    if (node.type !== "ExpressionStatement") continue;
    if (isStringLiteral(node.expression) && matchDirective(node.expression.value, directive)) {
      return node.expression;
    }
  }
}

function findInlineDirective(
  ast: Program,
  directive: string | RegExp,
): StringDirective | undefined {
  let result: StringDirective | undefined;

  function visit(value: unknown): void {
    if (result) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isUnknownRecord(value)) return;

    const nodeType = typeof value.type === "string" ? value.type : undefined;
    if (
      (nodeType === "FunctionDeclaration" ||
        nodeType === "FunctionExpression" ||
        nodeType === "ArrowFunctionExpression") &&
      isBlockStatement(value.body)
    ) {
      for (const statement of value.body.body) {
        if (
          isExpressionStatement(statement) &&
          isStringLiteral(statement.expression) &&
          matchDirective(statement.expression.value, directive)
        ) {
          result = statement.expression;
          return;
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
      visit(child);
    }
  }

  visit(ast);
  return result;
}

async function expandExportAll(
  transforms: RscTransforms,
  context: Rollup.TransformPluginContext,
  code: string,
  ast: Program,
  id: string,
): Promise<{ code: string } | undefined> {
  return transforms.transformExpandExportAll({
    code,
    ast,
    importer: id,
    resolve: async (source, importer) => (await context.resolve(source, importer))?.id,
    load: async (resolvedId) => {
      const source = await fs.promises.readFile(resolvedId, "utf8");
      const transformed = await transformWithOxc(source, resolvedId, { sourcemap: false });
      return parseProgram(transformed.code);
    },
  });
}

export async function createServerFunctionDirectivePlugin(options: Options): Promise<Plugin> {
  const rscModulePath = resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc");
  const transformsPath = resolvePluginRscModule(
    options.projectRoot,
    "@vitejs/plugin-rsc/transforms",
  );
  const rscRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/rsc/server"),
  ).href;
  const browserRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/browser"),
  ).href;
  const ssrRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/ssr"),
  ).href;
  const encryptionRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/utils/encryption-runtime"),
  ).href;
  const rscModule: typeof import("@vitejs/plugin-rsc") = await import(
    pathToFileURL(rscModulePath).href
  );
  const transforms: RscTransforms = await import(pathToFileURL(transformsPath).href);
  const { getPluginApi } = rscModule;
  let manager: RscPluginManager | undefined;

  const transformPlugin: Plugin = {
    name: SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME,

    configResolved(config) {
      manager = getPluginApi(config)?.manager;
    },

    transform: {
      async handler(code, id) {
        if (code.includes(SERVER_FUNCTION_DIRECTIVE_MARKER)) return;

        const active = options.definitions.filter(
          (definition) =>
            (definition.test?.(code) ?? code.includes("use ")) &&
            (!definition.filter || definition.filter(id)),
        );
        const isServer = this.environment.name === options.serverEnvironmentName;
        if (!manager) {
          throw new Error("vinext: failed to access @vitejs/plugin-rsc through getPluginApi().");
        }
        if (!manager.serverReferences) {
          throw new Error(
            "vinext: Installed @vitejs/plugin-rsc does not support user-land server reference claims.",
          );
        }
        if (active.length === 0) {
          manager.serverReferences.deleteClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id);
          return;
        }

        let ast = await parseProgram(code);
        const useServerBoundary = transforms.hasDirective(ast.body, "use server");
        if (!isServer && useServerBoundary) {
          manager.serverReferences.deleteClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id);
          return;
        }
        const reference = manager.serverReferences.resolve(id, options.serverEnvironmentName);

        if (!isServer) {
          for (const definition of active) {
            const inlineDirective = findInlineDirective(ast, definition.directive);
            if (inlineDirective && definition.clientError) {
              throw Object.assign(
                new Error(definition.clientError({ id, environment: this.environment.name })),
                { pos: inlineDirective.start },
              );
            }
          }

          const matches: Array<readonly [ServerFunctionDirective, StringDirective]> = [];
          for (const definition of active) {
            const moduleDirective = findModuleDirective(ast, definition.directive);
            if (moduleDirective) matches.push([definition, moduleDirective]);
          }
          if (matches.length === 0) {
            manager.serverReferences.deleteClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id);
            return;
          }
          if (matches.length > 1) {
            throw Object.assign(
              new Error("Multiple server function directives match this module."),
              {
                pos: matches[1]?.[1].start,
              },
            );
          }

          const match = matches[0];
          if (!match) return;
          const [, moduleDirective] = match;
          const result = transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: moduleDirective.value,
            runtime: (name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(`${reference.referenceKey}#${name}`)},$$ReactClient.callServer,undefined,${this.environment.mode === "dev" ? "$$ReactClient.findSourceMapURL" : "undefined"},${JSON.stringify(name)})`,
          });
          if (!result?.output.hasChanged()) {
            manager.serverReferences.deleteClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id);
            return;
          }
          manager.serverReferences.deleteClaim(USE_SERVER_PLUGIN_NAME, id);
          manager.serverReferences.replaceClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id, {
            ...reference,
            exportNames: result.exportNames,
          });
          result.output.prepend(
            `${SERVER_FUNCTION_DIRECTIVE_MARKER}\nimport * as $$ReactClient from ${JSON.stringify(this.environment.name === options.browserEnvironmentName ? browserRuntime : ssrRuntime)};\n`,
          );
          return {
            code: result.output.toString(),
            map: result.output.generateMap({ hires: "boundary", source: id }),
          };
        }

        const exportNames = new Set<string>();
        let needsReactRuntime = false;
        let needsEncryptionRuntime = false;
        let outputMap: SourceMap | undefined;

        for (const [definitionIndex, definition] of active.entries()) {
          const runtimeName = definition.runtime
            ? `$$server_function_directive_${definitionIndex}`
            : undefined;
          let runtimeUsed = false;
          const getRuntime = () => {
            if (runtimeName) runtimeUsed = true;
            return runtimeName;
          };

          let moduleDirective = findModuleDirective(ast, definition.directive);
          if (moduleDirective) {
            if (useServerBoundary) {
              throw Object.assign(
                new Error(
                  `A module cannot contain both ${JSON.stringify(moduleDirective.value)} and "use server" directives.`,
                ),
                { pos: moduleDirective.start },
              );
            }
            const expanded = await expandExportAll(transforms, this, code, ast, id);
            if (expanded) {
              code = expanded.code;
              ast = await parseProgram(code);
              moduleDirective = findModuleDirective(ast, definition.directive);
            }
          }

          const moduleMatch = moduleDirective
            ? matchDirective(moduleDirective.value, definition.directive)
            : undefined;
          if (moduleMatch) {
            definition.validate?.({ id, directive: moduleMatch[0], location: "module" });
          }

          const result = moduleMatch
            ? transforms.transformWrapExport(code, ast, {
                runtime: (value, name, meta) => {
                  needsReactRuntime = true;
                  return `$$VinextReactServer.registerServerReference(${definition.wrap({ value, name, id, directiveMatch: moduleMatch, location: "module", hasBoundArgs: false, parameters: meta.parameters, runtime: getRuntime(), meta })}, ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(name)})`;
                },
                filter: (name, meta) => definition.filterExport?.({ name, id, meta }) ?? true,
                rejectNonAsyncFunction: definition.rejectNonAsyncModule,
              })
            : transforms.transformHoistInlineDirective(code, ast, {
                directive: definition.directive,
                runtime: (value, name, meta) => {
                  definition.validate?.({
                    id,
                    directive: meta.directiveMatch[0],
                    location: "inline",
                  });
                  const wrapped = definition.wrap({
                    value,
                    name,
                    id,
                    directiveMatch: meta.directiveMatch,
                    location: "inline",
                    hasBoundArgs: meta.hasBoundArgs,
                    parameters: meta.parameters,
                    runtime: getRuntime(),
                  });
                  if (useServerBoundary) return wrapped;

                  needsReactRuntime = true;
                  if (meta.hasBoundArgs) {
                    needsEncryptionRuntime = true;
                    return `$$VinextReactServer.registerServerReference((($$wrapped) => async ($$encoded, ...$$args) => $$wrapped(...await __vite_rsc_encryption_runtime.decryptActionBoundArgs($$encoded), ...$$args))(${wrapped}), ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(name)})`;
                  }
                  return `$$VinextReactServer.registerServerReference(${wrapped}, ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(name)})`;
                },
                rejectNonAsyncFunction: definition.rejectNonAsyncFunction,
                encode: (value) => {
                  needsEncryptionRuntime = true;
                  return `__vite_rsc_encryption_runtime.encryptActionBoundArgs(${value})`;
                },
                stableName: true,
                exportWrappedHoist: !useServerBoundary,
                rejectForbiddenExpressions: true,
              });
          if (!result.output.hasChanged()) continue;

          if (moduleDirective) {
            result.output.overwrite(
              moduleDirective.start,
              moduleDirective.end,
              `/* ${JSON.stringify(moduleDirective.value)} */`,
            );
          }

          if (runtimeUsed && definition.runtime && runtimeName) {
            result.output.prepend(
              `import * as ${runtimeName} from ${JSON.stringify(definition.runtime)};\n`,
            );
          }

          const transformedNames = "names" in result ? result.names : result.exportNames;
          transformedNames.forEach((name) => exportNames.add(name));
          outputMap = result.output.generateMap({ hires: "boundary", source: id });
          code = result.output.toString();
          ast = await parseProgram(code);
        }

        if (!useServerBoundary && exportNames.size > 0) {
          manager.serverReferences.deleteClaim(USE_SERVER_PLUGIN_NAME, id);
          manager.serverReferences.replaceClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id, {
            ...reference,
            exportNames: [...exportNames],
          });
        } else {
          manager.serverReferences.deleteClaim(SERVER_FUNCTION_DIRECTIVE_PLUGIN_NAME, id);
        }

        const imports = [
          needsReactRuntime &&
            `import * as $$VinextReactServer from ${JSON.stringify(rscRuntime)};`,
          needsEncryptionRuntime &&
            `import * as __vite_rsc_encryption_runtime from ${JSON.stringify(encryptionRuntime)};`,
        ].filter(Boolean);
        return {
          code: `${SERVER_FUNCTION_DIRECTIVE_MARKER}\n${imports.join("\n")}\n${code}`,
          map: outputMap,
        };
      },
    },
  };

  return transformPlugin;
}
