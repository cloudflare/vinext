import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { TransformHoistInlineDirectiveMeta } from "@vitejs/plugin-rsc/transforms";
import { parseAstAsync, type Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";
import { withPositionedError } from "./worker-use-server.js";

type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type Program = Awaited<ReturnType<typeof parseAstAsync>>;

const PLUGIN_NAME = "vinext:inline-server-actions";

/**
 * Hoist inline `"use server"` functions in the RSC graph with closure captures
 * bound to their own action id.
 *
 * This mirrors the RSC-environment branch of plugin-rsc's `rsc:use-server` for
 * modules without a file-level `"use server"` directive
 * (`transformServerActionServer`): the same transform,
 * reference keys and export names. Only the capture encryption differs.
 * plugin-rsc encrypts captures without the action id, so a ciphertext issued
 * for one action decrypts as another action's captures. Like Next.js
 * (encryption.ts `encryptActionBoundArgs(actionId, ...)`), the captures are
 * encrypted together with the action id and only decrypt for that action.
 *
 * The hoisted functions' `"use server"` directives are removed so
 * `rsc:use-server`, which runs next, does not hoist them a second time.
 * File-level `"use server"` modules have no closures and stay with plugin-rsc.
 */
export async function createInlineServerActionPlugin(options: {
  projectRoot: string;
  boundArgsRuntime: string;
  allowMissingRsc?: boolean;
}): Promise<Plugin> {
  const resolve = (specifier: string): string => {
    try {
      return createRequire(path.join(options.projectRoot, "package.json")).resolve(specifier);
    } catch {
      return createRequire(import.meta.url).resolve(specifier);
    }
  };
  const [rscModule, transforms]: [typeof import("@vitejs/plugin-rsc"), RscTransforms] =
    await Promise.all([
      import(pathToFileURL(resolve("@vitejs/plugin-rsc")).href),
      import(pathToFileURL(resolve("@vitejs/plugin-rsc/transforms")).href),
    ]);
  const reactServerRuntime = pathToFileURL(resolve("@vitejs/plugin-rsc/react/rsc/server")).href;
  let manager: RscPluginManager | undefined;

  return {
    name: PLUGIN_NAME,
    configResolved(config) {
      const pluginApi = rscModule.getPluginApi(config);
      const hasRscPlugin = config.plugins.some((plugin) => plugin.name === "rsc");
      if (!pluginApi && options.allowMissingRsc && !hasRscPlugin) return;
      if (!pluginApi?.manager.serverReferences) {
        throw new Error("vinext: Server Actions require @vitejs/plugin-rsc 0.5.34 or newer.");
      }
      manager = pluginApi.manager;
    },
    transform: {
      // Like `rsc:use-server`, match every module id without a code filter, so
      // a module that no longer mentions the directive still drops its claim.
      async handler(code, id) {
        if (!manager || this.environment.name !== "rsc") return;
        if (!code.includes("use server")) {
          manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
          return;
        }
        const ast = await parseAstAsync(code);
        if (
          transforms.hasDirective(ast.body, "use server") ||
          transforms.findDirectives(ast, "use server").length === 0
        ) {
          manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
          return;
        }

        const reference = manager.serverReferences.resolve(id, "rsc");
        const actionId = (name: string | undefined) => {
          if (name === undefined) {
            throw new Error(`vinext: could not bind inline Server Action captures (${id}).`);
          }
          return JSON.stringify(`${reference.referenceKey}#${name}`);
        };
        // plugin-rsc calls `decode` before the same function's `runtime`, and
        // `encode` right after it.
        const decodedNames = getCapturingActionNames(transforms, code, ast);
        let decodeIndex = 0;
        let encodingName: string | undefined;
        const directives: Array<{ start: number; end: number }> = [];
        const result = await withPositionedError(this, () =>
          transforms.transformHoistInlineDirective(code, ast, {
            directive: "use server",
            rejectNonAsyncFunction: true,
            runtime: (value, name, meta) => {
              encodingName = name;
              directives.push(findUseServerDirective(meta.valueNode));
              return `$$ReactServer.registerServerReference(${value}, ${JSON.stringify(reference.referenceKey)}, ${JSON.stringify(name)})`;
            },
            encode: (value) => {
              const name = encodingName;
              encodingName = undefined;
              return `$$vinextBoundArgs.encryptActionBoundArgs(${actionId(name)}, ${value})`;
            },
            decode: (value) =>
              `await $$vinextBoundArgs.decryptActionBoundArgs(${actionId(decodedNames[decodeIndex++])}, ${value})`,
          }),
        );
        if (!result.output.hasChanged()) {
          manager.serverReferences.deleteClaim(PLUGIN_NAME, id);
          return;
        }

        // `update` keeps code plugin-rsc attached around the directive, such as
        // a nested action's declaration that starts right after it.
        for (const directive of directives) {
          result.output.update(directive.start, directive.end, "");
        }
        manager.serverReferences.replaceClaim(PLUGIN_NAME, id, {
          ...reference,
          exportNames: result.names,
        });
        result.output.prepend(
          `import * as $$ReactServer from ${JSON.stringify(reactServerRuntime)};\n` +
            `import * as $$vinextBoundArgs from ${JSON.stringify(options.boundArgsRuntime)};\n`,
        );
        return magicStringTransformResult(result.output, { hires: "boundary", source: id });
      },
    },
  };
}

/** Names of the inline actions that close over values, in transform order. */
function getCapturingActionNames(transforms: RscTransforms, code: string, ast: Program): string[] {
  const names: string[] = [];
  let decoded = false;
  transforms.transformHoistInlineDirective(code, ast, {
    directive: "use server",
    runtime: (_value, name) => {
      if (decoded) names.push(name);
      decoded = false;
      return "";
    },
    encode: (value) => value,
    decode: (value) => {
      decoded = true;
      return value;
    },
  });
  return names;
}

function findUseServerDirective(node: TransformHoistInlineDirectiveMeta["valueNode"]): {
  start: number;
  end: number;
} {
  // The transform only matches block bodies whose directive prologue holds
  // the exact directive.
  if (node.body.type === "BlockStatement") {
    for (const statement of node.body.body) {
      if (statement.type !== "ExpressionStatement" || !("directive" in statement)) break;
      if (statement.directive !== "use server") continue;
      // plugin-rsc's ESTree types omit the positions its parser records.
      const { start, end } = statement as typeof statement & { start: number; end: number };
      return { start, end };
    }
  }
  throw new Error('vinext: could not locate an inline "use server" directive.');
}
