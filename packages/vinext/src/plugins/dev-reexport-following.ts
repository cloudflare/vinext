/**
 * vinext:dev-reexport-following plugin
 *
 * Vite dev does not tree-shake, so importing one export from a barrel
 * evaluates every module the barrel re-exports. In the RSC environment that
 * breaks barrels whose unused leaves call `React.createContext()` at module
 * scope or import `client-only` (e.g. `import { Toast } from "@heroui/react"`,
 * https://github.com/cloudflare/vinext/issues/4007).
 *
 * Next.js (Turbopack) follows re-exports through side-effect-free modules in
 * dev and build, so only the module that defines an imported binding is
 * evaluated. This plugin does the same in the RSC dev environment: when an
 * import targets a module whose package declares it side-effect free
 * (`"sideEffects": false`, or a glob list that does not match the file), the
 * import is rewritten to the module that actually defines the binding.
 *
 *   import { Toast } from "@heroui/react"
 *   → import { Toast } from "/abs/node_modules/@heroui/react/dist/components/toast/index.js"
 *
 * Production builds already get this from Rolldown's tree-shaking.
 */

import type { ESTree, Plugin } from "vite";
import fs from "node:fs/promises";
import path from "pathslash";
import MagicString from "magic-string";
import { buildBarrelExportMap } from "./optimize-imports.js";
import { getAstName, parseProgram } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";

/** Re-export hops followed per imported binding. */
const MAX_HOPS = 10;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
// A plain script module, optionally with Vite's `?v=` dep version query.
// Other queries (`?raw`, `?url`, ...) are not followed.
const FOLLOWABLE_ID_RE = /^([^?\0]+\.(?:js|mjs|jsx|ts|mts|tsx))(?:\?v=[\w-]+)?$/;

type SideEffectsField = boolean | string[] | undefined;
type PackageScope = { dir: string; sideEffects: SideEffectsField };
type ResolvedModule = { id: string; file: string };

async function readFileSafe(filepath: string): Promise<string | null> {
  try {
    return await fs.readFile(filepath, "utf-8");
  } catch {
    return null;
  }
}

const LEADING_TRIVIA_RE = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
const DIRECTIVE_RE = /^(["'])([^"'\\\n]*)\1\s*;?/;

/**
 * Whether a module starts with a directive other than "use strict", such as
 * "use client", "use server", or "use cache". Re-exports must not be followed
 * through these modules: in the RSC environment a "use client" module's
 * exports are client references, and following them would import the
 * implementation as server code instead.
 */
function hasBoundaryDirective(code: string): boolean {
  let rest = code;
  for (;;) {
    rest = rest.slice(LEADING_TRIVIA_RE.exec(rest)?.[0].length ?? 0);
    const match = DIRECTIVE_RE.exec(rest);
    if (!match) return false;
    if (match[2] !== "use strict") return true;
    rest = rest.slice(match[0].length);
  }
}

/**
 * Source reader for export maps. Modules with a boundary directive read as
 * missing, so their re-exports, including through `export *`, are never
 * followed and imports of their bindings stay on the module itself.
 */
async function readFollowableSource(filepath: string): Promise<string | null> {
  const code = await readFileSafe(filepath);
  return code === null || hasBoundaryDirective(code) ? null : code;
}

/**
 * Convert a `sideEffects` glob to a RegExp matched against the path relative
 * to the package root. Patterns without a `/` match the file name in any
 * directory, as in webpack and Rolldown.
 */
function sideEffectsGlobToRegExp(pattern: string): RegExp {
  let glob = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (!glob.includes("/")) glob = `**/${glob}`;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories.
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        source += "\\{";
      } else {
        const options = glob.slice(i + 1, end).split(",");
        source += `(?:${options.map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        i = end;
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function createDevReexportFollowingPlugin(): Plugin {
  // Nearest package.json scope for each directory.
  const scopeCache = new Map<string, PackageScope | null>();
  const globCache = new Map<string, RegExp>();
  const exportMapCache: NonNullable<Parameters<typeof buildBarrelExportMap>[2]> = new Map();
  let cacheDir = "";

  async function findPackageScope(dir: string): Promise<PackageScope | null> {
    const visited: string[] = [];
    let current = dir;
    let scope: PackageScope | null = null;
    for (;;) {
      const cached = scopeCache.get(current);
      if (cached !== undefined) {
        scope = cached;
        break;
      }
      visited.push(current);
      const raw = await readFileSafe(path.join(current, "package.json"));
      if (raw !== null) {
        let pkg: { name?: unknown; sideEffects?: unknown } | null = null;
        try {
          pkg = JSON.parse(raw);
        } catch {
          pkg = null;
        }
        // Nested `{ "type": "module" }` manifests inside a package's dist
        // folder don't define a package scope; the root manifest does.
        if (pkg && (typeof pkg.name === "string" || "sideEffects" in pkg)) {
          const sideEffects = pkg.sideEffects;
          scope = {
            dir: current,
            sideEffects:
              typeof sideEffects === "boolean" ||
              (Array.isArray(sideEffects) &&
                sideEffects.every((entry) => typeof entry === "string"))
                ? sideEffects
                : undefined,
          };
          break;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const visitedDir of visited) scopeCache.set(visitedDir, scope);
    return scope;
  }

  function scopeIsSideEffectFree(scope: PackageScope | null, file: string): boolean {
    if (!scope) return false;
    if (scope.sideEffects === false) return true;
    if (!Array.isArray(scope.sideEffects)) return false;
    const relative = path.relative(scope.dir, file);
    return !scope.sideEffects.some((pattern) => {
      let re = globCache.get(pattern);
      if (!re) {
        re = sideEffectsGlobToRegExp(pattern);
        globCache.set(pattern, re);
      }
      return re.test(relative);
    });
  }

  /**
   * The file behind a resolved id, or null if the module can't be followed.
   * The id itself is what rewritten imports point at: Vite's dev resolver
   * appends a `?v=` dep version to `node_modules` ids, and importing the same
   * file with and without it would evaluate it twice.
   */
  function followableModule(id: string): ResolvedModule | null {
    const match = FOLLOWABLE_ID_RE.exec(id);
    if (!match || !path.isAbsolute(match[1])) return null;
    // Pre-bundled deps must keep being imported through the optimized bundle.
    if (cacheDir && match[1].startsWith(cacheDir + "/")) return null;
    return { id, file: match[1] };
  }

  async function isSideEffectFree(file: string): Promise<boolean> {
    return scopeIsSideEffectFree(await findPackageScope(path.dirname(file)), file);
  }

  return {
    name: "vinext:dev-reexport-following",
    apply: "serve",

    configResolved(config) {
      cacheDir = config.cacheDir;
    },

    buildStart() {
      scopeCache.clear();
      exportMapCache.clear();
    },

    transform: {
      filter: {
        id: {
          include: /\.(?:tsx?|jsx?|mjs)(?:\?.*)?$/,
          exclude: VIRTUAL_MODULE_ID_RE,
        },
        code: /\bimport\b[\s\S]*\bfrom\b/,
      },
      async handler(code, id) {
        if (this.environment.name !== "rsc") return null;

        let ast: ESTree.Program;
        try {
          ast = parseProgram(code);
        } catch {
          return null;
        }
        // plugin-rsc replaces "use client" modules with client references in
        // the RSC environment, so their imports are never evaluated there.
        if (hasUseClientDirective(ast)) return null;

        const importerDir = path.dirname(id.split("?")[0]);

        const s = new MagicString(code);
        let hasChanges = false;

        imports: for (const node of ast.body) {
          if (node.type !== "ImportDeclaration" || node.specifiers.length === 0) continue;
          if (node.attributes && node.attributes.length > 0) continue;
          const source = typeof node.source.value === "string" ? node.source.value : null;
          if (!source) continue;
          // Skip resolving relative imports whose target directory isn't in a
          // package that declares side-effect-free modules (most app code).
          if (source.startsWith(".") && path.isAbsolute(importerDir)) {
            const scope = await findPackageScope(path.join(importerDir, source));
            if (scope?.sideEffects !== false && !Array.isArray(scope?.sideEffects)) continue;
          }

          const resolved = await this.resolve(source, id);
          if (!resolved || resolved.external) continue;
          const entry = followableModule(resolved.id);
          if (!entry || !(await isSideEffectFree(entry.file))) continue;

          // Specifiers that stay on the original import, and import statements
          // for the specifiers that were retargeted.
          const kept: string[] = [];
          const statements: string[] = [];
          let retargeted = false;
          for (const spec of node.specifiers) {
            if (spec.type === "ImportNamespaceSpecifier") {
              statements.push(`import * as ${spec.local.name} from ${JSON.stringify(source)};`);
              continue;
            }
            const imported =
              spec.type === "ImportDefaultSpecifier" ? "default" : getAstName(spec.imported);
            const local = spec.local.name;
            if (imported === null) continue imports;

            // Follow `export { x } from`, `export * from`, and
            // `import { x }; export { x }` through side-effect-free modules to
            // the module that defines `x`.
            let name = imported;
            let target: ResolvedModule = entry;
            let namespace = false;
            for (let hop = 0; hop < MAX_HOPS; hop++) {
              const exportMap = await buildBarrelExportMap(
                target.file,
                readFollowableSource,
                exportMapCache,
              );
              const reexport = exportMap?.get(name);
              if (!reexport || reexport.source === target.file) break;
              const resolvedNext = await this.resolve(reexport.source, target.id);
              if (!resolvedNext || resolvedNext.external) break;
              const next = followableModule(resolvedNext.id);
              if (!next) break;
              target = next;
              if (reexport.isNamespace) {
                namespace = true;
                break;
              }
              name = reexport.originalName ?? name;
              if (!(await isSideEffectFree(target.file))) break;
            }

            if (target === entry) {
              kept.push(formatSpecifier(imported, local));
            } else {
              retargeted = true;
              const targetId = JSON.stringify(target.id);
              statements.push(
                namespace
                  ? `import * as ${local} from ${targetId};`
                  : `import { ${formatSpecifier(name, local)} } from ${targetId};`,
              );
            }
          }

          if (!retargeted) continue;
          if (kept.length > 0) {
            statements.unshift(`import { ${kept.join(", ")} } from ${JSON.stringify(source)};`);
          }
          s.overwrite(node.start, node.end, statements.join(" "));
          hasChanges = true;
        }

        return hasChanges ? magicStringTransformResult(s) : null;
      },
    },
  } satisfies Plugin;
}

function hasUseClientDirective(ast: ESTree.Program): boolean {
  for (const node of ast.body) {
    if (node.type !== "ExpressionStatement" || !("directive" in node)) return false;
    if (node.directive === "use client") return true;
  }
  return false;
}

function formatSpecifier(imported: string, local: string): string {
  if (imported === local) return local;
  const name = IDENTIFIER_RE.test(imported) ? imported : JSON.stringify(imported);
  return `${name} as ${local}`;
}
