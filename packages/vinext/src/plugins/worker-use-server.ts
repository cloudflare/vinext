import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import { parseAstAsync, transformWithOxc, type Plugin, type ResolvedConfig } from "vite";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";
import { magicStringTransformResult } from "./transform-result.js";

type RscPluginModule = typeof import("@vitejs/plugin-rsc");
type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type RscCoreModule = { default: () => Plugin[] };

const WORKER_SCRIPT_RE = /\.(?:[cm]?[jt]sx?)$/;
const WORKER_CALL_SERVER = `function $$vinextWorkerCallServer() {
  return new Promise(() => {
    reportError(new Error("Server Functions cannot be called from a browser Web Worker."));
  });
}
`;

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
    transform: {
      filter: {
        id: { include: WORKER_SCRIPT_RE, exclude: VIRTUAL_MODULE_ID_RE },
        code: "use server",
      },
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
            load: async (target) =>
              parseAstAsync(
                (
                  await transformWithOxc(await fs.promises.readFile(target, "utf-8"), target, {
                    sourcemap: false,
                  })
                ).code,
              ),
          }),
        );
        if (expanded) {
          code = expanded.code;
          ast = await parseAstAsync(code);
        }

        const { referenceKey } = manager.serverReferences.resolve(id, "rsc");
        const result = await withPositionedError(this, () =>
          transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: "use server",
            rejectNonAsyncFunction: true,
            runtime: (name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(`${referenceKey}#${name}`)}, $$vinextWorkerCallServer, undefined, undefined, ${JSON.stringify(name)})`,
          }),
        );
        if (!result?.output.hasChanged()) return null;
        result.output.prepend(
          `import * as $$ReactClient from ${JSON.stringify(browserRuntime)};\n${WORKER_CALL_SERVER}`,
        );
        return magicStringTransformResult(result.output);
      },
    },
  };

  // The proxies import React's Flight client, which needs the same
  // `__webpack_require__` patch plugin-rsc applies to the main graphs.
  const patchPlugins = rscCore
    .default()
    .filter((plugin) => plugin.name === "rsc:patch-react-server-dom-webpack");
  if (patchPlugins.length === 0) {
    throw new Error("vinext: @vitejs/plugin-rsc no longer exposes its Flight client patch plugin.");
  }
  return [...patchPlugins, useServerPlugin];
}
