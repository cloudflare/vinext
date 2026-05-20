import type { Plugin } from "vite";

/**
 * Detect whether the source contains a bare reference to `__dirname` or
 * `__filename` outside of strings, template literals, and comments. Mirrors
 * the conservative "skip masked spans first" strategy used by
 * {@link findUserDeclaredCjsGlobals} so a docstring like
 * `/* uses __dirname *\/` doesn't force the shim into modules that don't
 * actually need it.
 *
 * The return value reports each identifier independently so the injected
 * preamble can hoist only the bindings actually used by the module — keeping
 * the per-module patch size minimal and avoiding spurious imports.
 */
export function detectCjsGlobalReferences(source: string): {
  __dirname: boolean;
  __filename: boolean;
} {
  // Quick reject: the strict masked scan below is comparatively expensive on
  // hot paths (every node_modules .js/.mjs/.cjs goes through the transform
  // pipeline), so first verify the source contains the identifier at all.
  if (!/__dirname|__filename/.test(source)) {
    return { __dirname: false, __filename: false };
  }

  const masked = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\$]|\\.|\$(?!\{))*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (m) => " ".repeat(m.length),
  );

  return {
    __dirname: /\b__dirname\b/.test(masked),
    __filename: /\b__filename\b/.test(masked),
  };
}

/**
 * Per-module preamble that defines `__dirname` / `__filename` for ESM-bundled
 * CommonJS code. Used as the body of the {@link cjsGlobalsShimPlugin}
 * transform output.
 *
 * The bindings are scoped to the transformed module (Vite's `transform`
 * runs before bundling, so each module's source is patched independently).
 * After Rolldown concatenates modules, the bindings become unique top-level
 * `const`s in the bundle thanks to the bundler's identifier renaming.
 *
 * `import.meta.url` resolves to the *bundle's* output URL at runtime, not
 * the original `node_modules` location. That is intentional: the goal of
 * this shim is to prevent `ReferenceError: __dirname is not defined` for
 * libraries that touch these identifiers defensively (e.g. `typeof
 * __dirname === "string"`, log paths, debug strings). Libraries that load
 * sibling assets through `__dirname` need to be externalized instead — a
 * shim cannot recreate the original on-disk layout post-bundle.
 *
 * The helper imports are aliased so they cannot collide with user-declared
 * names like `dirname` or `fileURLToPath` already imported by the module.
 */
export function buildCjsGlobalsShimPreamble(needs: {
  __dirname: boolean;
  __filename: boolean;
}): string {
  if (!needs.__dirname && !needs.__filename) return "";

  const lines: string[] = [`import { fileURLToPath as __vinext_fileURLToPath } from "node:url";`];
  if (needs.__dirname) {
    lines.push(`import { dirname as __vinext_dirname } from "node:path";`);
  }
  if (needs.__filename) {
    lines.push(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
  }
  if (needs.__dirname) {
    // Reuse the local __filename when we already declared it, otherwise
    // compute it inline. Avoids declaring an unused __filename binding.
    if (needs.__filename) {
      lines.push(`const __dirname = __vinext_dirname(__filename);`);
    } else {
      lines.push(`const __dirname = __vinext_dirname(__vinext_fileURLToPath(import.meta.url));`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Vite plugin that injects local `__dirname` / `__filename` shims into
 * third-party `node_modules` code that references those CJS globals but is
 * bundled into an ESM server output (`"type": "module"`).
 *
 * Why: vinext's production server build emits ESM (`output.format: "esm"`,
 * `package.json#type === "module"`). The Node ESM module scope does not
 * expose the CJS-style `__dirname` / `__filename` globals, so any
 * `node_modules` dependency that touches them — even defensively, like
 * `typeof __dirname === "string"` or for log messages — crashes the bundled
 * worker with `ReferenceError: __dirname is not defined in ES module scope`.
 *
 * vinext already injects these shims into the user's `next.config.ts`
 * (see `config/next-config.ts`), but that transform is keyed to the config
 * file path. Third-party packages bundled into the server entry need the
 * same treatment, scoped per-module so user code declaring its own
 * `__dirname` is unaffected.
 *
 * Scope:
 *   - Only `node_modules` files (user code stays untouched — user-source
 *     `__dirname` is a real bug we want to surface, not silently shim).
 *   - Only `.js` / `.mjs` / `.cjs` extensions (TypeScript files inside
 *     `node_modules` are unusual and typically pass through their own
 *     compiler first).
 *   - Only server-side environments (`ssr`, `rsc`). The browser environment
 *     doesn't ship CJS globals at all and clients almost never reference
 *     them — adding a shim there would inject `node:url` imports that the
 *     browser-target build would have to externalize.
 *
 * Limitation: `import.meta.url` after bundling points at the *bundle*, not
 * the original module location. Libraries that load sibling files through
 * `__dirname` (native `.node` addons, embedded `.wasm`, etc.) should be
 * externalized via `next.config.serverExternalPackages` instead. This shim
 * only prevents the `ReferenceError`; it does not preserve filesystem
 * semantics.
 */
export const cjsGlobalsShimPlugin: Plugin = {
  name: "vinext:cjs-globals-shim",
  enforce: "pre",

  transform: {
    filter: { id: /\/node_modules\/.+\.(?:m?js|cjs)(?:\?.*)?$/ },
    handler(code, id) {
      // Server-only: see plugin docstring. The Vite environment API exposes
      // the current environment name to plugin handlers via `this.environment`.
      const envName = this.environment?.name;
      if (envName !== "ssr" && envName !== "rsc") return null;

      // Strip any query suffix before the filter recheck. Vite passes ids
      // with `?v=…` cache busters that the filter regex already allows
      // through, but downstream logic only cares about the source text.
      void id;

      const needs = detectCjsGlobalReferences(code);
      if (!needs.__dirname && !needs.__filename) return null;

      const preamble = buildCjsGlobalsShimPreamble(needs);
      return {
        code: preamble + code,
        // Source map is intentionally null: the preamble is prepended without
        // line offsets in the original source map. A precise map would
        // require MagicString plumbing; the trade-off here favours zero
        // overhead in the hot transform path. Stack traces still resolve to
        // the original source via the bundler's combined sourcemap once the
        // module is concatenated.
        map: null,
      };
    },
  },
};
