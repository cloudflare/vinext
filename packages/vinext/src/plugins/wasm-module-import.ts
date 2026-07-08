import fs from "node:fs";
import type { Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

/**
 * vinext:wasm-module-import — handle `import x from '*.wasm?module'`.
 *
 * Resolutions marked external by Vite or a target adapter are preserved. For
 * non-external resolutions, this plugin reads the WASM file, inlines it as
 * base64, and exports a compiled WebAssembly.Module.
 *
 * Fixes #1351.
 */
export function createWasmModuleImportPlugin(): Plugin {
  return {
    name: "vinext:wasm-module-import",
    enforce: "pre",

    resolveId: {
      // Match import specifiers that end with `.wasm?module`. The exact
      // match (no extra query params) is intentional: `?module` as the
      // entire query string is the documented Cloudflare/Next.js
      // convention, and anything else (e.g. `?module&v=1`) is not a shape
      // we want to silently claim — leave it to the bundler to error on.
      filter: { id: /\.wasm\?module$/ },
      async handler(source: string, importer: string | undefined) {
        // `?module` is a server/edge convention with no meaning in browser
        // bundles, and the emitted top-level await may not be valid for the
        // configured client build.target. Never claim the import for the
        // client environment — leave it to the bundler, which errors loudly
        // instead of silently shipping TLA into a client chunk.
        if (this.environment?.name === "client") return null;

        // Skip imports originating from @vercel/og — vinext:og-font-patch
        // converts those to dynamic imports whose .catch() fallback reads from
        // disk on Node.js.  If we intercept them here and inline the bytes as
        // base64, the dynamic import succeeds on Node.js too, defeating the
        // fallback, causing the ~1.3 MB resvg WASM to be shipped twice, and
        // breaking findEmittedWasmAsset dedup in vinext:og-assets.
        //
        // The substring predicate deliberately mirrors the
        // vinext:og-font-patch transform filter (`id.includes("@vercel/og")`
        // in index.ts) — the two must never diverge, or an id matched by the
        // font-patch transform could slip past this guard and reintroduce
        // the double-shipped-WASM bug.
        const importerPath = importer
          ? (importer.startsWith("\0") ? importer.slice(1) : importer).split("?")[0]
          : "";
        if (importerPath.includes("@vercel/og")) return null;

        // Let Vite's resolver find the absolute path (it handles
        // relative specifiers, tsconfig paths, etc.), then strip the
        // ?module query so the result is a real file path.
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved) return null;
        if (resolved.external) return resolved;
        const filePath = stripViteModuleQuery(resolved.id);
        return `\0vinext-wasm-module:${filePath}`;
      },
    },

    load: {
      // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
      filter: { id: /^\u0000vinext-wasm-module:/ },
      handler(id: string) {
        // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
        const filePath = id.replace(/^\u0000vinext-wasm-module:/, "");
        // Record the dependency on the underlying .wasm file so editing it
        // in dev invalidates and reloads the importing module.
        this.addWatchFile(filePath);
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(filePath);
        } catch {
          // `this.error` throws; returning it makes the control flow
          // explicit so no non-null assertion is needed below.
          return this.error(`[vinext] Could not read WASM file: ${filePath}`);
        }
        // Inline the WASM binary as a base64 string and compile it at
        // module initialisation time.  atob() is available on Node 16+,
        // browsers, and workerd. Top-level await is safe because the
        // resolveId handler above never claims `.wasm?module` for the
        // client environment, so this output only lands in server/edge
        // (SSR) bundles, where Vite/Rolldown always emits ESM.
        const base64 = bytes.toString("base64");
        return [
          `const _b64 = ${JSON.stringify(base64)};`,
          `const _buf = Uint8Array.from(atob(_b64), c => c.charCodeAt(0));`,
          `export default await WebAssembly.compile(_buf.buffer);`,
        ].join("\n");
      },
    },
  };
}
