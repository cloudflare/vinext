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
  const localBindings = new Set<string>();
  const strippedRanges: Array<{ start: number; end: number }> = [];

  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id) {
      localBindings.add(node.id.name);
    } else if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        if (declarator.id?.type === "Identifier") {
          localBindings.add(declarator.id.name);
        }
      }
    } else if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration" && decl.id) {
        localBindings.add(decl.id.name);
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type === "Identifier") {
            localBindings.add(declarator.id.name);
          }
        }
      }
    }
  }

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
        strippedRanges.push({ start: node.start, end: node.end });
        changed = true;
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type === "Identifier" && SERVER_EXPORTS.has(declarator.id.name)) {
            s.overwrite(node.start, node.end, `export const ${declarator.id.name} = undefined;`);
            strippedRanges.push({ start: node.start, end: node.end });
            changed = true;
          }
        }
      }
      continue;
    }

    // Case 3: export { getServerSideProps } or export { getServerSideProps as gSSP }
    if (node.specifiers && node.specifiers.length > 0 && !node.source) {
      const kept: Extract<ASTNode, { type: "ExportSpecifier" }>[] = [];
      const stripped: Array<{ exportedName: string; localName: string }> = [];
      for (const spec of node.specifiers) {
        // spec.local.name is the binding name, spec.exported.name is the export name
        // oxlint-disable-next-line typescript/no-explicit-any
        const exportedName = (spec.exported as any)?.name ?? (spec.exported as any)?.value;
        // oxlint-disable-next-line typescript/no-explicit-any
        const localName = (spec.local as any)?.name ?? (spec.local as any)?.value ?? exportedName;
        if (SERVER_EXPORTS.has(exportedName)) {
          stripped.push({ exportedName, localName });
        } else {
          kept.push(spec);
        }
      }
      if (stripped.length > 0) {
        // Build replacement: keep non-server specifiers, add stubs for stripped ones
        const parts: string[] = [];
        if (kept.length > 0) {
          const keptStr = kept
            // oxlint-disable-next-line typescript/no-explicit-any
            .map((sp: any) => {
              const local = sp.local.name;
              const exported = sp.exported?.name ?? sp.exported?.value;
              return local === exported ? local : `${local} as ${exported}`;
            })
            .join(", ");
          parts.push(`export { ${keptStr} };`);
        }
        for (const { exportedName, localName } of stripped) {
          // `const getServerSideProps = ...; export { getServerSideProps }`
          // already has a local binding. Emitting `export const ...` would
          // redeclare that binding and make the client build fail before tree
          // shaking. Removing the export is enough to hide it from the client.
          if (localName === exportedName && localBindings.has(localName)) {
            continue;
          }
          parts.push(`export const ${exportedName} = undefined;`);
        }
        s.overwrite(node.start, node.end, parts.join("\n"));
        strippedRanges.push({ start: node.start, end: node.end });
        changed = true;
      }
    }
  }

  if (!changed) return null;

  let analysisCode = code;
  for (const { start, end } of strippedRanges) {
    analysisCode = analysisCode.slice(0, start) + " ".repeat(end - start) + analysisCode.slice(end);
  }
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      analysisCode =
        analysisCode.slice(0, node.start) +
        " ".repeat(node.end - node.start) +
        analysisCode.slice(node.end);
    }
  }

  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const localNames = node.specifiers
      .map((specifier) => specifier.local?.name)
      .filter((name): name is string => Boolean(name));
    if (localNames.length === 0) continue;

    const isUsedOutsideStrippedServerExports = localNames.some((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(analysisCode),
    );
    if (!isUsedOutsideStrippedServerExports) {
      s.remove(node.start, node.end);
    }
  }

  return s.toString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
