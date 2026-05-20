import { parseAst } from "vite";
import MagicString from "magic-string";

type ASTNode = ReturnType<typeof parseAst>["body"][number]["parent"];

/**
 * Strip server-only data-fetching exports (getServerSideProps,
 * getStaticProps, getStaticPaths) from page modules for the client
 * bundle. Uses Vite's parseAst (Rollup/acorn) for correct handling
 * of all export patterns including function expressions, arrow
 * functions with TS return types, and re-exports.
 *
 * Modeled after Next.js's SWC `next-ssg-transform`.
 */
export function stripServerExports(code: string): string | null {
  const SERVER_EXPORTS = new Set(["getServerSideProps", "getStaticProps", "getStaticPaths"]);
  if (![...SERVER_EXPORTS].some((name) => code.includes(name))) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    // If parsing fails (shouldn't happen post-JSX/TS transform), bail out
    return null;
  }

  const s = new MagicString(code);
  let changed = false;

  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;

    // Case 1: export function name() {} / export async function name() {}
    // Case 2: export const/let/var name = ...
    if (node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration" && decl.id && SERVER_EXPORTS.has(decl.id.name)) {
        s.overwrite(
          node.start,
          node.end,
          `export function ${decl.id.name}() { return { props: {} }; }`,
        );
        changed = true;
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type === "Identifier" && SERVER_EXPORTS.has(declarator.id.name)) {
            s.overwrite(node.start, node.end, `export const ${declarator.id.name} = undefined;`);
            changed = true;
          }
        }
      }
      continue;
    }

    // Case 3: export { getServerSideProps } or export { getServerSideProps as gSSP }
    //
    // We must NOT emit `export const getServerSideProps = undefined` here:
    // the user typically has a local `const getServerSideProps = ...` (or
    // `function getServerSideProps() {}`) binding in the same scope that the
    // specifier re-exports. Re-declaring the binding with `const` would
    // produce a `Identifier ... has already been declared` parse error under
    // OXC/Rolldown, which is stricter than the legacy webpack/esbuild
    // pipeline. Instead, drop the specifier entirely and let the now-unused
    // local declaration be tree-shaken.
    //
    // This matches Next.js's `next-ssg-transform` behavior, which removes
    // server-export specifiers without emitting a stub.
    if (node.specifiers && node.specifiers.length > 0 && !node.source) {
      const kept: Extract<ASTNode, { type: "ExportSpecifier" }>[] = [];
      let strippedAny = false;
      for (const spec of node.specifiers) {
        // spec.local.name is the binding name, spec.exported.name is the export name
        // oxlint-disable-next-line typescript/no-explicit-any
        const exportedName = (spec.exported as any)?.name ?? (spec.exported as any)?.value;
        if (SERVER_EXPORTS.has(exportedName)) {
          strippedAny = true;
        } else {
          kept.push(spec);
        }
      }
      if (strippedAny) {
        if (kept.length > 0) {
          const keptStr = kept
            // oxlint-disable-next-line typescript/no-explicit-any
            .map((sp: any) => {
              const local = sp.local.name;
              const exported = sp.exported?.name ?? sp.exported?.value;
              return local === exported ? local : `${local} as ${exported}`;
            })
            .join(", ");
          s.overwrite(node.start, node.end, `export { ${keptStr} };`);
        } else {
          // Drop the entire `export { ... }` statement.
          s.overwrite(node.start, node.end, "");
        }
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return s.toString();
}
