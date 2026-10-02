import { parseAst } from "vite";

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
  const start = output.lastIndexOf(EXPORT_FACADE_START);
  if (start === -1) return undefined;
  const end = output.indexOf(EXPORT_FACADE_END, start);
  if (end === -1) return undefined;
  const stripped = output.slice(0, start) + output.slice(end + EXPORT_FACADE_END.length);
  return hasEsmExports(stripped) ? stripped : undefined;
}
