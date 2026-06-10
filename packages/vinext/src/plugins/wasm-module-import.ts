import fs from "node:fs";
import type { Plugin } from "vite";

/**
 * vinext:wasm-module-import — handle `import x from '*.wasm?module'` in
 * non-Cloudflare builds.
 *
 * The `?module` query is a Cloudflare Workers / workerd convention: it tells
 * the bundler to load a `.wasm` file as a pre-compiled WebAssembly.Module
 * rather than raw bytes. When @cloudflare/vite-plugin is present it handles
 * this for all worker environments via its `additionalModulesPlugin`
 * (enforce:"pre"), so we must not interfere.
 *
 * In plain Node.js builds (no Cloudflare plugin — the case for the
 * deploy-suite and standalone `vinext start`) Rolldown has no built-in
 * `?module` handler and throws. This plugin fills the gap by:
 *   1. Intercepting any `*.wasm?module` import in resolveId.
 *   2. Reading the WASM file at load time and inlining it as base64.
 *   3. Exporting a compiled WebAssembly.Module via top-level await.
 *
 * workerd forbids compiling WASM from bytes at runtime — modules must come
 * from the bundler module system. The getHasCloudflarePlugin() check inside
 * the resolveId handler ensures this path only runs in Node.js environments
 * where WebAssembly.compile() from bytes is permitted.
 *
 * NOTE: the gating assumption is "no @cloudflare/vite-plugin", not
 * "Node.js target". The two can diverge: e.g. Nitro's edge presets
 * (Cloudflare, Deno Deploy) don't register the Cloudflare vite-plugin, so
 * this plugin would intercept `.wasm?module` there and the emitted
 * `WebAssembly.compile(bytes)` would be rejected at runtime by workerd.
 * If that combination ever needs support, the gate must consider the
 * target runtime rather than (only) plugin presence.
 *
 * NOTE: `hasCloudflarePlugin` is set in vinext's `config` hook (after the
 * plugins array is constructed), so the flag is passed in as a getter and
 * read at hook call-time, where it reflects the final resolved value.
 *
 * Fixes #1351.
 */
export function createWasmModuleImportPlugin(options: {
  getHasCloudflarePlugin: () => boolean;
}): Plugin {
  const { getHasCloudflarePlugin } = options;

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
        // Defer to @cloudflare/vite-plugin when it's present — it handles
        // ?module imports for all worker environments via its own
        // `additionalModulesPlugin` (also enforce:"pre").  Both plugins have
        // the same enforce level; by checking this flag at call-time we let
        // Cloudflare's plugin "win" by returning null here and allowing it to
        // intercept first in the registration order.
        if (getHasCloudflarePlugin()) return null;

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
        const filePath = stripModuleQuery(resolved.id);
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

/**
 * Strip the query/hash suffix from a Vite module id (`/a/b.wasm?module` →
 * `/a/b.wasm`). Local copy of index.ts's `stripViteModuleQuery` — small
 * enough that sharing it isn't worth an index.ts export cycle.
 */
function stripModuleQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}
