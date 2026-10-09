import type { Plugin } from "vite";

const SERVER_ONLY_SPECIFIER_RE = /^server-only$/;

/**
 * Reject `server-only` imports inside browser Web Worker bundles.
 *
 * Vite bundles every worker in a fresh plugin container built from
 * `worker.plugins`, so neither `vinext:validate-server-only-client-imports`
 * nor @vitejs/plugin-rsc's `rsc:validate-imports` sees worker modules in
 * production builds. Next.js compiles workers as part of the browser graph
 * and fails the build for these imports with both webpack and Turbopack.
 *
 * Like `rsc:validate-imports`, this guards resolution rather than scanning
 * source, so every specifier form (static, dynamic, re-export, require) is
 * caught before vinext's no-op `server-only` alias applies. Unlike the main
 * client validator, `"use server"` modules are not exempt: the worker
 * container has no Server Function transform, so their module bodies would
 * be emitted verbatim.
 */
export function createWorkerServerOnlyImportsPlugin(): Plugin {
  return {
    name: "vinext:worker-validate-server-only-imports",
    resolveId: {
      order: "pre",
      filter: { id: SERVER_ONLY_SPECIFIER_RE },
      handler(_source, importer) {
        throw new Error(
          `You're importing a module that depends on "server-only". This API is only available in Server Components in the App Router, but ${importer ?? "this module"} is reachable from a browser Web Worker bundle.`,
        );
      },
    },
  };
}
