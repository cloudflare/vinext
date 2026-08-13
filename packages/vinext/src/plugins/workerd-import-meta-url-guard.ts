import { parseAst, type Plugin } from "vite";
import MagicString from "magic-string";

/**
 * Guard `fileURLToPath(import.meta.url)` / `createRequire(import.meta.url)`
 * call sites so module init survives workerd.
 *
 * workerd does not provide `import.meta.url` for bundled modules (it is
 * undefined), so libraries that resolve paths from it at module init —
 * e.g. findUp-style package.json discovery — crash with "The path argument
 * must be of type string or an instance of URL". This affects both user
 * source and node_modules dependencies.
 *
 * The rewrite is deliberately narrow: only the two call shapes that crash
 * are guarded (`?? "file:///"`); all other import.meta.url usage is left
 * untouched, and the fallback merely changes the resolved path — these
 * libraries only walk upwards from it (on workerd, `fileURLToPath("file:///")`
 * yields "/" and findUp terminates immediately). The guard is a no-op on
 * Node, where import.meta.url is always defined.
 *
 * Known boundaries (deliberate):
 * - Calls are matched by callee name without import-source verification —
 *   a user module shadowing `fileURLToPath`/`createRequire` gets the same
 *   rewrite (harmless on Node; on workerd the argument changes from
 *   `undefined` to `"file:///"`).
 * - TS postfix forms (`import.meta.url as string`, `import.meta.url!`) and
 *   computed access (`import.meta["url"]`) are not guarded.
 * - The `"file:///"` fallback is only meaningful under workerd's POSIX-style
 *   file URL handling; other runtimes that lack import.meta.url would need
 *   revalidation.
 */

/**
 * Conservative superset filter: the handler (AST-based) is authoritative —
 * this only decides whether a module is worth parsing. The window between the
 * callee and the argument is unbounded because block comments of arbitrary
 * length can sit between them (a bounded window silently misses calls in
 * annotated dependencies); string/comment false positives are rejected by
 * the handler.
 */
export const WORKERD_IMPORT_META_URL_FILTER =
  /(?:fileURLToPath|createRequire)[\s\S]{0,20}?\([\s\S]*?import\.meta\s*(?:\.|\?\.)\s*url/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentifier(node: unknown, name: string): boolean {
  return isRecord(node) && node.type === "Identifier" && node.name === name;
}

function isImportMetaUrl(node: unknown): boolean {
  return (
    isRecord(node) &&
    node.type === "MemberExpression" &&
    isRecord(node.object) &&
    node.object.type === "MetaProperty" &&
    isRecord(node.object.meta) &&
    node.object.meta.name === "import" &&
    isRecord(node.object.property) &&
    node.object.property.name === "meta" &&
    isIdentifier(node.property, "url")
  );
}

// import.meta?.url parses as ChainExpression wrapping the MemberExpression.
function isChainedImportMetaUrl(node: unknown): boolean {
  return isRecord(node) && node.type === "ChainExpression" && isImportMetaUrl(node.expression);
}

export function createWorkerdImportMetaUrlGuardPlugin(): Plugin {
  return {
    name: "vinext:workerd-import-meta-url-guard",
    // Runs after TS/JSX transforms so parseAst sees plain JS (same reasoning
    // as the use-cache transform). No environment filtering: the crash
    // affects server bundles, and the client bundle is untouched because
    // browser import.meta.url is defined (`??` is a no-op there).
    enforce: "post",
    transform: {
      filter: {
        id: { include: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/ },
        code: WORKERD_IMPORT_META_URL_FILTER,
      },
      handler(code) {
        return guardImportMetaUrlCalls(code);
      },
    },
  };
}

/**
 * Rewrite `fileURLToPath(import.meta.url)` and `createRequire(import.meta.url)`
 * argument expressions to `import.meta.url ?? "file:///"`. Returns null when
 * nothing changed.
 */
export function guardImportMetaUrlCalls(
  code: string,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const s = new MagicString(code);
  let changed = false;

  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;

    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (isIdentifier(callee, "fileURLToPath") || isIdentifier(callee, "createRequire")) {
        const args = node.arguments;
        if (Array.isArray(args)) {
          for (const arg of args) {
            const target =
              isImportMetaUrl(arg) || isChainedImportMetaUrl(arg)
                ? (arg as { start: number; end: number })
                : null;
            if (target) {
              s.overwrite(target.start, target.end, `import.meta.url ?? "file:///"`);
              changed = true;
            }
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  };

  visit(ast);

  if (!changed) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ hires: "boundary" }),
  };
}
