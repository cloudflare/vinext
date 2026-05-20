import { parseAst, type Plugin } from "vite";
import MagicString from "magic-string";

/**
 * Recursively collect the named ESM exports of a module by parsing its source
 * with Vite's parseAst. Handles:
 *   - `export function foo() {}` / `export const foo = ...`
 *   - `export { foo }` / `export { foo as bar }`
 *   - `export { foo } from './x'` / `export { foo as bar } from './x'`
 *   - `export default ...` (recorded as `default`)
 *   - `export * as Ns from './x'` (recorded as `Ns`)
 *   - `export * from './x'` (recursively walks `./x` and merges named exports)
 *
 * `default` exports from `export * from` sources are intentionally NOT inherited,
 * matching standard ESM semantics.
 */

type RollupResolveFn = (
  source: string,
  importer: string,
  options: { skipSelf: boolean },
) => Promise<{ id: string; external?: boolean } | null>;

type RollupLoadFn = (options: { id: string }) => Promise<{ code: string | null } | null>;

type ExportAllDecl = {
  start: number;
  end: number;
  source: string;
  /** Set when the declaration is `export * as Ns from '...'`; null for the bare form. */
  namespaceName: string | null;
};

/**
 * Returns true if `code` begins with a `"use client"` (or `'use client'`)
 * directive, allowing leading whitespace, line comments, and block comments.
 *
 * Implemented as a manual scan rather than a regex to avoid catastrophic
 * backtracking on adversarial inputs (e.g. CodeQL js/redos on patterns of the
 * form `(?:\/\*[\s\S]*?\*\/\s*|...)*`). Each character is visited at most once.
 */
function quickHasUseClient(code: string): boolean {
  const len = code.length;
  let i = 0;
  while (i < len) {
    const c = code.charCodeAt(i);
    // Skip ASCII whitespace (space, tab, LF, CR, FF, VT).
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b) {
      i++;
      continue;
    }
    // Skip `// line comment` to end of line.
    if (c === 0x2f && i + 1 < len && code.charCodeAt(i + 1) === 0x2f) {
      i += 2;
      while (i < len && code.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    // Skip `/* block comment */`.
    if (c === 0x2f && i + 1 < len && code.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      while (i < len) {
        if (code.charCodeAt(i) === 0x2a && i + 1 < len && code.charCodeAt(i + 1) === 0x2f) {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    // First non-whitespace/non-comment token: must be a `"use client"` string.
    if (c !== 0x22 && c !== 0x27) return false;
    const quote = c;
    const rest = code.slice(i + 1, i + 1 + "use client".length);
    if (rest !== "use client") return false;
    const after = code.charCodeAt(i + 1 + "use client".length);
    return after === quote;
  }
  return false;
}

/**
 * Result of collecting exports from a re-exported module. Used to expand
 * `export * from './x'` into explicit named re-exports.
 */
type CollectedExports = {
  /** Named exports declared (excluding the default export). */
  names: string[];
  /** True if the source could not be resolved/loaded/parsed. */
  unresolved: boolean;
};

/**
 * Collect the set of named exports (no default) that `export * from <source>`
 * would re-export from the given resolved module id. Recurses through chained
 * `export * from` declarations until a fixed point or a cycle is reached.
 */
async function collectNamedExports(
  resolvedId: string,
  resolve: RollupResolveFn,
  load: RollupLoadFn,
  visited: Set<string>,
): Promise<CollectedExports> {
  if (visited.has(resolvedId)) return { names: [], unresolved: false };
  visited.add(resolvedId);

  let loaded: { code: string | null } | null;
  try {
    loaded = await load({ id: resolvedId });
  } catch {
    return { names: [], unresolved: true };
  }
  const code = loaded?.code;
  if (!code) return { names: [], unresolved: true };

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return { names: [], unresolved: true };
  }

  const names = new Set<string>();
  let unresolved = false;

  // Walk a binding pattern (Identifier / ObjectPattern / ArrayPattern /
  // AssignmentPattern / RestElement) and collect every bound identifier name.
  // Lets us pick up destructured exports like
  //   `export const { Provider, Consumer } = createContext()`
  // or `export const [first, second] = tuple`.
  const collectPatternNames = (
    pattern: { type: string; [key: string]: unknown } | null | undefined,
  ): void => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier": {
        const name = (pattern as { name?: unknown }).name;
        if (typeof name === "string") names.add(name);
        return;
      }
      case "ObjectPattern": {
        const props = (pattern as { properties?: unknown[] }).properties ?? [];
        for (const prop of props) {
          const p = prop as { type?: string; value?: unknown; argument?: unknown };
          if (p.type === "RestElement") {
            collectPatternNames(p.argument as { type: string });
          } else {
            collectPatternNames(p.value as { type: string });
          }
        }
        return;
      }
      case "ArrayPattern": {
        const elements = (pattern as { elements?: unknown[] }).elements ?? [];
        for (const el of elements) collectPatternNames(el as { type: string });
        return;
      }
      case "RestElement": {
        collectPatternNames((pattern as { argument?: unknown }).argument as { type: string });
        return;
      }
      case "AssignmentPattern": {
        collectPatternNames((pattern as { left?: unknown }).left as { type: string });
        return;
      }
    }
  };

  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (
          (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") &&
          decl.id?.name
        ) {
          names.add(decl.id.name);
        } else if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            collectPatternNames(d.id as { type: string });
          }
        }
      } else {
        for (const spec of node.specifiers ?? []) {
          const exportedName =
            spec.exported?.type === "Identifier"
              ? spec.exported.name
              : spec.exported?.type === "Literal"
                ? String(spec.exported.value)
                : null;
          if (exportedName && exportedName !== "default") names.add(exportedName);
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      // Skip — `export * from` does not forward the default export.
    } else if (node.type === "ExportAllDeclaration") {
      const rawSource = typeof node.source?.value === "string" ? node.source.value : null;
      if (!rawSource) continue;

      if (node.exported) {
        // `export * as Name from "./x"` re-exports the namespace under `Name`.
        const exportedName =
          node.exported.type === "Identifier"
            ? node.exported.name
            : node.exported.type === "Literal"
              ? String(node.exported.value)
              : null;
        if (exportedName) names.add(exportedName);
        continue;
      }

      // `export * from "./x"` — recursively merge `./x`'s named exports.
      let nested: { id: string } | null;
      try {
        nested = await resolve(rawSource, resolvedId, { skipSelf: true });
      } catch {
        nested = null;
      }
      if (!nested || nested.id === resolvedId) {
        unresolved = true;
        continue;
      }
      const sub = await collectNamedExports(nested.id, resolve, load, visited);
      if (sub.unresolved) unresolved = true;
      for (const name of sub.names) names.add(name);
    }
  }

  return { names: [...names], unresolved };
}

/**
 * Find each `export * from '...'` declaration in `code` along with its byte
 * range and source specifier. Returns null if the AST cannot be parsed (the
 * downstream RSC transform will surface the original parse error).
 */
function findExportAllDeclarations(code: string): ExportAllDecl[] | null {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const result: ExportAllDecl[] = [];
  for (const node of ast.body) {
    if (node.type !== "ExportAllDeclaration") continue;
    const rawSource = typeof node.source?.value === "string" ? node.source.value : null;
    if (!rawSource) continue;
    // `export * as Ns from "./x"` carries an `exported` identifier; the bare
    // `export * from "./x"` form does not. The upstream RSC transform rejects
    // both, so we must rewrite both forms.
    let namespaceName: string | null = null;
    if (node.exported) {
      if (node.exported.type === "Identifier") namespaceName = node.exported.name;
      else if (node.exported.type === "Literal") namespaceName = String(node.exported.value);
      else continue;
    }
    result.push({ start: node.start, end: node.end, source: rawSource, namespaceName });
  }
  return result;
}

/**
 * Returns true if the file appears to contain a top-level `export * from`
 * declaration (no `as` namespace). Used as a fast pre-filter before parsing.
 */
function quickHasExportAll(code: string): boolean {
  // Match both `export * from '...'` and `export * as Ns from '...'`. The
  // upstream RSC transform rejects both forms, so both need rewriting.
  return /(^|\n|;)\s*export\s*\*\s*(?:as\s+\w+\s+)?from\s*['"]/.test(code);
}

/**
 * Workaround for @vitejs/plugin-rsc's `rsc:use-client` transform, which throws
 * "unsupported ExportAllDeclaration" when a `"use client"` module contains a
 * bare `export * from '...'` declaration.
 *
 * This plugin runs BEFORE `rsc:use-client` in the RSC (server) environment.
 * For each `"use client"` file that contains `export * from '...'`, it
 * resolves the target module, enumerates its named exports, and rewrites the
 * declaration to an explicit `export { a, b, c } from '...'` form that the
 * RSC plugin already understands.
 *
 * Tracked upstream: https://github.com/vitejs/vite-plugin-react/issues/1233
 *
 * Reference: Next.js's flight loader treats `export *` similarly (it sets the
 * module source type back to `module` so webpack handles the re-export, rather
 * than generating per-export proxies). See
 * .nextjs-ref/packages/next/src/build/webpack/loaders/next-flight-loader/index.ts
 */
export function createUseClientExportAllPlugin(): Plugin {
  return {
    name: "vinext:use-client-export-all",
    // Run at the default enforce position (same as `rsc:use-client`). We
    // intentionally do NOT use `enforce: "pre"` because that would run before
    // Vite's built-in oxc transform converts TS/JSX to plain JS, and our AST
    // parse step (`parseAst`) only accepts standard ESM. Plugin order at the
    // default position is determined by array index, and vinext registers
    // this plugin earlier than the auto-injected `@vitejs/plugin-rsc`, so
    // our transform reaches each module before `rsc:use-client` does.

    transform: {
      filter: { id: /\.(?:m|c)?[jt]sx?$/ },
      async handler(code, id) {
        // Only run in the RSC environment — that's where `rsc:use-client`
        // performs the failing transform. The SSR and client environments
        // either don't run the proxy export transform or already strip the
        // directive.
        if (this.environment?.name !== "rsc") return null;

        // Skip non-source modules (virtual modules, query suffixes other than
        // the bare file id).
        if (id.startsWith("\0")) return null;

        // Fast string checks before AST parsing.
        if (!quickHasUseClient(code)) return null;
        if (!quickHasExportAll(code)) return null;

        const declarations = findExportAllDeclarations(code);
        if (!declarations || declarations.length === 0) return null;

        const s = new MagicString(code);
        let changed = false;

        for (const decl of declarations) {
          const sourceLiteral = JSON.stringify(decl.source);

          if (decl.namespaceName !== null) {
            // `export * as Ns from "./x"` → `import * as Ns from "./x"; export { Ns };`
            // This produces a single named export the upstream transform can
            // convert into a client-reference proxy. The named binding holds
            // the module namespace object; consumers can access its members
            // through the proxy.
            const ns = decl.namespaceName;
            s.overwrite(
              decl.start,
              decl.end,
              `import * as ${ns} from ${sourceLiteral};\nexport { ${ns} };`,
            );
            changed = true;
            continue;
          }

          const resolved = await this.resolve(decl.source, id, { skipSelf: true });
          if (!resolved || resolved.external) {
            // External or unresolved sources can't be enumerated at transform
            // time. Leave the declaration alone — the upstream transform will
            // surface its existing error and the user can switch to explicit
            // named re-exports.
            continue;
          }

          // oxlint-disable-next-line typescript/no-this-alias -- closure captures the rollup plugin context for the recursive resolver
          const pluginCtx = this;
          const collected = await collectNamedExports(
            resolved.id,
            async (source, importer, opts) => {
              const r = await pluginCtx.resolve(source, importer, opts);
              if (!r) return null;
              return { id: r.id, external: typeof r.external === "boolean" ? r.external : false };
            },
            async ({ id: loadId }) => {
              const loaded = await pluginCtx.load({ id: loadId });
              return { code: typeof loaded?.code === "string" ? loaded.code : null };
            },
            new Set([id]),
          );

          if (collected.unresolved && collected.names.length === 0) continue;

          // If the target had no named exports (only default, or empty),
          // replace the declaration with a no-op import that preserves any
          // side effects from evaluating the module.
          const replacement =
            collected.names.length === 0
              ? `import ${sourceLiteral};`
              : `export { ${collected.names.join(", ")} } from ${sourceLiteral};`;

          s.overwrite(decl.start, decl.end, replacement);
          changed = true;
        }

        if (!changed) return null;
        return { code: s.toString(), map: s.generateMap({ hires: "boundary" }) };
      },
    },
  };
}
