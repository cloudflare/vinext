import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";

// vite-plugin-commonjs appends its export facade between these markers.
const EXPORT_FACADE_START = "/* [vite-plugin-commonjs] export-statement-S */";
const EXPORT_FACADE_END = "/* [vite-plugin-commonjs] export-statement-E */";

// The word `export`, but not the plugin's `export-runtime-S/E` marker comments.
const EXPORT_KEYWORD_RE = /\bexport\b(?!-)/;

/** Whether `code` has a top-level ESM export statement. */
function hasEsmExports(code: string): boolean {
  if (!EXPORT_KEYWORD_RE.test(code)) return false;
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return false;
  }
  return ast.body.some(
    (statement) =>
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration",
  );
}

/**
 * Removes the export facade vite-plugin-commonjs appended to `output` when the
 * module it transformed is ESM. Returns `undefined` when there is nothing to
 * remove.
 *
 * Next.js treats a module with ESM syntax as ESM: `require()` still works, but
 * `module` / `exports` never become its exports. The plugin's analyzer is not
 * scope-aware, so for bundled ESM that inlines CommonJS wrappers
 * (`__commonJS((exports, module) => …)`) it exports the wrappers' assignments
 * too, which duplicates the module's own exports. Its `require()` rewrite and
 * its local `module` / `exports` polyfill stay, so free CommonJS assignments
 * still run without becoming exports.
 *
 * Besides the facade, the plugin only prepends imports and its polyfill and
 * rewrites `require()` calls, so the module's own top-level exports are still
 * in `output`. Classifying the output rather than rereading the source keeps
 * the decision tied to the exact code the plugin transformed.
 *
 * The facade is appended after the module's code (only dynamic-require
 * runtimes, which have no source mappings, may follow it), so removing it
 * leaves the plugin's source map valid.
 */
export function stripEsmCommonJsExportFacade(output: string): string | undefined {
  const facade = findEsmCommonJsExportFacade(output);
  return facade && output.slice(0, facade[0]) + output.slice(facade[1]);
}

/** The `[start, end)` range of the facade {@link stripEsmCommonJsExportFacade} removes. */
function findEsmCommonJsExportFacade(output: string): [number, number] | undefined {
  const start = output.lastIndexOf(EXPORT_FACADE_START);
  if (start === -1) return undefined;
  const end = output.indexOf(EXPORT_FACADE_END, start);
  if (end === -1) return undefined;
  const facadeEnd = end + EXPORT_FACADE_END.length;
  return hasEsmExports(output.slice(0, start) + output.slice(facadeEnd))
    ? [start, facadeEnd]
    : undefined;
}

/**
 * Applies {@link stripEsmCommonJsExportFacade} in the client dependency
 * optimizer's Rolldown builds (scan and pre-bundle). vite-plugin-commonjs's
 * pre-bundle plugin loads and converts files there without vinext's transform
 * wrapper, so its output reaches this hook as the loaded code. That code is
 * the optimizer's source, so the removal needs its own map for anything the
 * plugin appended after the facade.
 */
export const commonJsEsmFacadeOptimizeDepsPlugin: Plugin = {
  name: "vinext:commonjs-esm-facade:optimize-deps",
  transform: {
    filter: { code: { include: EXPORT_FACADE_START } },
    handler(code, id) {
      const facade = findEsmCommonJsExportFacade(code);
      if (!facade) return null;
      const output = new MagicString(code).remove(facade[0], facade[1]);
      return {
        code: output.toString(),
        map: output.generateMap({ source: id, hires: "boundary" }),
      };
    },
  },
};
