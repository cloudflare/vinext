/**
 * vinext WASM `?module` import support
 *
 * Cloudflare Workers accept `import wasm from "./foo.wasm?module"` and the
 * runtime instantiates the binary into a `WebAssembly.Module`. The Cloudflare
 * Vite plugin already handles this for environments that map to a Worker (it
 * marks the import as external and emits the `.wasm` as an asset). Other
 * environments — vinext's RSC and SSR Node builds, the browser client build,
 * or any non-Workers build — have no native support, and Rolldown/Vite fail
 * with `UNLOADABLE_DEPENDENCY: Could not load src/foo.wasm?module` (see
 * cloudflare/vinext#1351).
 *
 * Next.js solves the same problem via Webpack's experimental
 * `asyncWebAssembly` (see `.nextjs-ref/test/e2e/edge-can-use-wasm-files/`).
 * The Webpack output reads the WASM via `WebAssembly.instantiate(bytes)` from
 * an emitted asset. We mirror that behaviour for non-Workers environments
 * while letting the Cloudflare plugin keep its native handling for Workers.
 *
 * This plugin:
 *   1. Intercepts `*.wasm?module` resolveId only in non-Workers environments.
 *      In Workers environments the Cloudflare plugin's `enforce: "pre"` hook
 *      runs first and externalises the import; we never see it.
 *   2. Reads the binary, emits it as a Rollup asset so it lands in the build
 *      output directory with a hashed filename.
 *   3. Returns a tiny JS module whose default export is a pre-compiled
 *      `WebAssembly.Module`, located via `new URL("./<hashed>.wasm", import.meta.url)`
 *      and compiled with `WebAssembly.compile(await fs.readFile(url))`. The
 *      shape matches Workers' `?module` default export (a `WebAssembly.Module`),
 *      so user code such as
 *
 *          import wasm from "./add.wasm?module";
 *          const instance = await WebAssembly.instantiate(wasm);
 *
 *      works identically across both runtimes.
 *
 * Dev (`vite serve`) is handled the same way — the asset is still emitted via
 * `this.emitFile` in build, but in serve mode we fall back to reading the
 * source file directly from disk via its absolute path. This keeps the dev
 * server working without an asset pipeline.
 */

import type { Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";

const WASM_MODULE_RE = /\.wasm\?module(?:&.*)?$/;

/**
 * Create the `vinext:wasm-module` Vite plugin.
 *
 * The plugin opts out for Workers environments by deferring to whatever
 * earlier `enforce: "pre"` plugin (currently `@cloudflare/vite-plugin`) marks
 * `.wasm?module` as external. We only handle the resolveId/load path when no
 * one else has — that is, when the import would otherwise reach Rolldown and
 * fail to load.
 */
export function wasmModulePlugin(): Plugin {
  let isBuild = false;

  return {
    name: "vinext:wasm-module",
    // `post` so that any environment-specific plugin (notably
    // `@cloudflare/vite-plugin`, which uses `enforce: "pre"`) has already had
    // a chance to externalise the import for Workers builds. We only step in
    // when nobody else claimed the id, i.e. non-Workers environments where
    // the import would otherwise be unloadable.
    enforce: "post",

    configResolved(config) {
      isBuild = config.command === "build";
    },

    resolveId: {
      filter: { id: WASM_MODULE_RE },
      async handler(source, importer) {
        // Strip the `?module` query so Vite's default resolver can locate
        // the file on disk relative to the importer. We re-attach the query
        // to the returned id so `load` knows this was a `?module` request.
        const [bare, query = ""] = source.split("?");
        const resolved = await this.resolve(bare, importer, { skipSelf: true });
        if (!resolved) return null;
        return `${resolved.id}?${query}`;
      },
    },

    async load(id) {
      if (!WASM_MODULE_RE.test(id)) return null;
      const filePath = id.split("?")[0];

      let source: Buffer;
      try {
        source = await fs.promises.readFile(filePath);
      } catch (err) {
        this.error(
          `[vinext:wasm-module] Could not read WASM file ${filePath}: ${(err as Error).message}`,
        );
        // `this.error` throws, but Rollup's type signature is not `never`. The
        // explicit throw makes the unreachable path explicit and guarantees
        // `source` is initialised below.
        throw err;
      }

      const isClient = this.environment?.name === "client";

      if (isBuild) {
        // Emit the binary as a hashed asset so it ends up in the output dir
        // and we can reference it from the generated JS via import.meta.url.
        const referenceId = this.emitFile({
          type: "asset",
          name: path.basename(filePath),
          source,
        });

        // The default export must be a `WebAssembly.Module` to match the
        // shape that Workers' native `?module` import provides. We compile
        // the binary at module-evaluation time using `WebAssembly.compile`
        // against bytes located via Rollup's `ROLLUP_FILE_URL_<ref>` token,
        // which Rollup expands to an absolute `file://` / public-path URL
        // string at chunk-emit time.
        //
        // We emit two different shims so the client bundle never references
        // `node:*` modules (Vite externalises those to empty stubs in the
        // browser environment — see plugins/async-hooks-stub.ts) and the
        // server shim never carries dead browser fetch code.
        if (isClient) {
          // `compileStreaming` requires the response to advertise
          // `Content-Type: application/wasm`. Not all static hosts/CDNs set
          // that header, so we fall back to buffering + `compile` if the
          // streaming path rejects. See:
          // https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/compileStreaming
          return [
            `const __vinext_wasm_url = import.meta.ROLLUP_FILE_URL_${referenceId};`,
            `async function __vinext_load_wasm_module() {`,
            `  const res = await fetch(__vinext_wasm_url);`,
            `  if (typeof WebAssembly.compileStreaming === "function") {`,
            `    try { return await WebAssembly.compileStreaming(res.clone()); } catch {}`,
            `  }`,
            `  return WebAssembly.compile(await res.arrayBuffer());`,
            `}`,
            `export default await __vinext_load_wasm_module();`,
          ].join("\n");
        }

        // Server (rsc / ssr / non-Workers Node). Use dynamic `import("node:*")`
        // so the static dependency graph stays clean of `node:` imports — that
        // matters when this module is pulled into a chunk that may be analysed
        // by the bundler for client-safety, and it avoids the empty-stub
        // SyntaxError class of bug (see plugins/async-hooks-stub.ts).
        return [
          `const __vinext_wasm_url = import.meta.ROLLUP_FILE_URL_${referenceId};`,
          `async function __vinext_load_wasm_module() {`,
          `  const [{ readFile }, { fileURLToPath }] = await Promise.all([`,
          `    import("node:fs/promises"),`,
          `    import("node:url"),`,
          `  ]);`,
          `  const bytes = await readFile(fileURLToPath(__vinext_wasm_url));`,
          `  return WebAssembly.compile(bytes);`,
          `}`,
          `export default await __vinext_load_wasm_module();`,
        ].join("\n");
      }

      // Dev server: skip asset emission and compile from the source file
      // directly so HMR keeps working without an asset pipeline. The dev
      // server's client requests are also handled here — in that case we
      // ship a fetch-based shim that re-requests the wasm over the Vite
      // dev server, because `node:fs` is not available in the browser.
      if (isClient) {
        // In dev, Vite's middleware serves arbitrary on-disk files via the
        // `/@fs/<absolute-path>` URL prefix (the same mechanism it uses to
        // serve `node_modules` and out-of-root sources). This is the safe,
        // documented way to dereference an absolute path from the browser
        // during dev — passing the raw absolute path to `fetch()` would
        // resolve against the page origin and 404.
        // https://vitejs.dev/guide/api-javascript.html#vite-server
        const fetchUrl = JSON.stringify(`/@fs${filePath}`);
        return [
          `async function __vinext_load_wasm_module() {`,
          `  const res = await fetch(${fetchUrl});`,
          `  if (typeof WebAssembly.compileStreaming === "function") {`,
          `    try { return await WebAssembly.compileStreaming(res.clone()); } catch {}`,
          `  }`,
          `  return WebAssembly.compile(await res.arrayBuffer());`,
          `}`,
          `export default await __vinext_load_wasm_module();`,
        ].join("\n");
      }
      const absPath = JSON.stringify(filePath);
      return [
        `const { readFile: __vinext_readFile } = await import("node:fs/promises");`,
        `export default await WebAssembly.compile(await __vinext_readFile(${absPath}));`,
      ].join("\n");
    },
  } satisfies Plugin;
}
