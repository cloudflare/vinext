import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path, { toSlash } from "pathslash";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import { parseAstAsync, transformWithOxc, type Plugin, type ResolvedConfig } from "vite";
import { escapeRegExp } from "../utils/regex.js";
import { magicStringTransformResult } from "./transform-result.js";

type RscPluginModule = typeof import("@vitejs/plugin-rsc");
type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type RscCoreModule = { default: () => Plugin[] };

const WORKER_REFERENCE_RUNTIME_ID = "\0vinext:worker-server-reference";
const WORKER_REFERENCE_RUNTIME_ID_RE = /^\0vinext:worker-server-reference$/;

function workerReferenceRuntime(browserRuntime: string): string {
  return `import { createServerReference } from ${JSON.stringify(browserRuntime)};

function callServer() {
  return new Promise(() => {
    reportError(new Error("Server Functions cannot be called from a browser Web Worker."));
  });
}

export function createWorkerServerReference(id, name) {
  return createServerReference(id, callServer, undefined, undefined, name);
}
`;
}

/** A module-local binding that cannot collide with any name in `code`. */
function uniqueBinding(code: string, base: string): string {
  let binding = base;
  while (code.includes(binding)) binding += "_";
  return binding;
}

function isPlainFilePath(id: string): boolean {
  return !/[\0?#]/.test(id) && fs.existsSync(id);
}

function withPositionedError<T>(
  ctx: { error(message: string, pos?: number): never },
  run: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      if (error instanceof Error && "pos" in error && typeof error.pos === "number") {
        ctx.error(error.message, error.pos);
      }
      throw error;
    });
}

/**
 * Replace `"use server"` modules in browser Web Worker bundles with Server
 * Function reference proxies.
 *
 * Vite bundles every worker in a fresh plugin container built from
 * `worker.plugins`, so @vitejs/plugin-rsc's `rsc:use-server` transform never
 * sees worker modules in production builds and the module bodies would be
 * emitted verbatim. Next.js compiles workers as part of the browser graph,
 * where `"use server"` exports become `createServerReference(...)` proxies.
 * This mirrors the client-environment branch of `rsc:use-server` with the
 * same reference keys, without claiming references.
 *
 * The worker realm has no router to dispatch Server Function calls. Next.js's
 * `callServer` dispatches inside `startTransition`, so the dispatch error is
 * reported globally and the call's promise never settles; the worker
 * references reproduce that instead of reaching the server.
 */
export async function createWorkerUseServerPlugins(options: {
  rscPluginModule: Promise<RscPluginModule>;
  rscPluginPath: string;
}): Promise<Plugin[]> {
  const rscRequire = createRequire(options.rscPluginPath);
  const importRscModule = (specifier: string) =>
    import(pathToFileURL(rscRequire.resolve(specifier)).href);
  const browserRuntime = pathToFileURL(rscRequire.resolve("@vitejs/plugin-rsc/react/browser")).href;
  const [transforms, rscCore]: [RscTransforms, RscCoreModule] = await Promise.all([
    importRscModule("@vitejs/plugin-rsc/transforms"),
    importRscModule("@vitejs/plugin-rsc/core/plugin"),
  ]);
  let manager: RscPluginManager | undefined;

  const useServerPlugin: Plugin = {
    name: "vinext:worker-use-server",
    async configResolved(config) {
      // Worker configs keep the parent config on `mainConfig`; that is where
      // @vitejs/plugin-rsc's plugin API (and its reference manager) lives.
      const mainConfig = (config as ResolvedConfig & { mainConfig?: ResolvedConfig }).mainConfig;
      manager = (await options.rscPluginModule).getPluginApi(mainConfig ?? config)?.manager;
    },
    resolveId: {
      filter: { id: WORKER_REFERENCE_RUNTIME_ID_RE },
      handler: (source) => source,
    },
    load: {
      filter: { id: WORKER_REFERENCE_RUNTIME_ID_RE },
      handler: () => workerReferenceRuntime(browserRuntime),
    },
    transform: {
      // Like `rsc:use-server`, match every module id (queries, hashes and
      // virtual modules included); the directive check below narrows it.
      filter: { code: "use server" },
      async handler(code, id) {
        let ast = await parseAstAsync(code);
        if (!transforms.hasDirective(ast.body, "use server")) return null;
        if (!manager) {
          throw new Error(
            'vinext: cannot compile a "use server" module in a Web Worker without @vitejs/plugin-rsc.',
          );
        }

        const expanded = await withPositionedError(this, () =>
          transforms.transformExpandExportAll({
            code,
            ast,
            importer: id,
            resolve: async (source, importer) => (await this.resolve(source, importer))?.id,
            // Read plain files like `rsc:use-server` (export names only, no
            // full transform); anything else (virtual modules, queries) has
            // to come from the plugin pipeline.
            load: async (target) =>
              parseAstAsync(
                isPlainFilePath(target)
                  ? (
                      await transformWithOxc(await fs.promises.readFile(target, "utf-8"), target, {
                        sourcemap: false,
                      })
                    ).code
                  : ((await this.load({ id: target })).code ?? ""),
              ),
          }),
        );
        if (expanded) {
          code = expanded.code;
          ast = await parseAstAsync(code);
        }

        const { referenceKey } = manager.serverReferences.resolve(id, "rsc");
        const runtime = uniqueBinding(code, "$$vinextWorkerReference");
        const result = await withPositionedError(this, () =>
          transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: "use server",
            rejectNonAsyncFunction: true,
            runtime: (name) =>
              `${runtime}(${JSON.stringify(`${referenceKey}#${name}`)}, ${JSON.stringify(name)})`,
          }),
        );
        if (!result?.output.hasChanged()) return null;
        result.output.prepend(
          `import { createWorkerServerReference as ${runtime} } from ${JSON.stringify(WORKER_REFERENCE_RUNTIME_ID)};\n`,
        );
        return magicStringTransformResult(result.output);
      },
    },
  };

  // The proxies import React's Flight client, which needs the
  // `__webpack_require__` patch plugin-rsc applies to the main graphs. Scope
  // it to the vendored client so other worker modules stay untouched.
  const patchHook = rscCore
    .default()
    .find((plugin) => plugin.name === "rsc:patch-react-server-dom-webpack")?.transform;
  if (!patchHook || typeof patchHook !== "object") {
    throw new Error("vinext: @vitejs/plugin-rsc no longer exposes its Flight client patch plugin.");
  }
  const flightClientDir = path.dirname(
    rscRequire.resolve("@vitejs/plugin-rsc/vendor/react-server-dom/client.browser"),
  );
  const patchPlugin: Plugin = {
    name: "vinext:worker-patch-react-server-dom",
    transform: {
      filter: {
        id: new RegExp(`^${escapeRegExp(`${toSlash(flightClientDir)}/`)}`),
        code: "__webpack_require__",
      },
      handler: patchHook.handler,
    },
  };
  return [patchPlugin, useServerPlugin];
}
