import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Plugin } from "vite";
import { createIdResolver, parseAst } from "vite";
import MagicString from "magic-string";
import path from "pathslash";
import { isUnknownRecord as isRecord } from "../utils/record.js";
import { stripViteModuleQuery } from "../utils/path.js";

const PUBLIC_REQUIRE_TARGET_PREFIX = "virtual:vinext/require-condition/";
const BARE_IMPORT_RE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/;
const SCRIPT_MODULE_RE = /\.[cm]?[jt]sx?$/i;

type AstRecord = Record<string, unknown>;

type StaticRequire = {
  argumentEnd: number;
  argumentStart: number;
  specifier: string;
};

type RequireTarget = {
  filePath: string;
  resolved: {
    external: boolean | "absolute";
    id: string;
    moduleSideEffects: boolean | "no-treeshake" | null;
  };
};

function walkAst(value: unknown, visitor: (node: AstRecord) => void): void {
  if (!isRecord(value)) return;
  visitor(value);

  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") continue;
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visitor);
    } else if (isRecord(child)) {
      walkAst(child, visitor);
    }
  }
}

function collectStaticBareRequires(ast: unknown): StaticRequire[] {
  const requires: StaticRequire[] = [];

  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!isRecord(callee) || callee.type !== "Identifier" || callee.name !== "require") return;

    const args = Array.isArray(node.arguments) ? node.arguments : [];
    if (args.length !== 1 || !isRecord(args[0])) return;
    const argument = args[0];
    if (
      argument.type !== "Literal" ||
      typeof argument.value !== "string" ||
      !BARE_IMPORT_RE.test(argument.value) ||
      argument.value.startsWith(PUBLIC_REQUIRE_TARGET_PREFIX) ||
      typeof argument.start !== "number" ||
      typeof argument.end !== "number"
    ) {
      return;
    }

    requires.push({
      argumentStart: argument.start,
      argumentEnd: argument.end,
      specifier: argument.value,
    });
  });

  return requires;
}

function parserLanguage(id: string): "ts" | "tsx" {
  return /\.[cm]?ts$/i.test(stripViteModuleQuery(id)) ? "ts" : "tsx";
}

function virtualExtension(id: string): string {
  const extension = path.extname(stripViteModuleQuery(id)).toLowerCase();
  if (extension === ".ts" || extension === ".cts" || extension === ".mts") return ".ts";
  if (extension === ".tsx") return ".tsx";
  if (extension === ".jsx") return ".jsx";
  return ".js";
}

function virtualTargetId(resolvedId: string): string {
  const hash = createHash("sha256").update(resolvedId).digest("hex").slice(0, 16);
  return `${PUBLIC_REQUIRE_TARGET_PREFIX}${hash}${virtualExtension(resolvedId)}`;
}

/**
 * Preserve per-call `require` export conditions before vite-plugin-commonjs
 * rewrites static requires to ESM imports.
 *
 * Vite's resolver distinguishes `require-call` from `import-statement`, but
 * that information is lost after the CommonJS transform. Only packages whose
 * two resolutions differ are virtualized. The virtual JavaScript identity also
 * lets the existing CommonJS and RSC transforms process require-selected `.cjs`
 * client modules without Rolldown reparsing their generated ESM as CommonJS.
 */
export function createRequireConditionPlugin(): Plugin {
  const targetsByPublicId = new Map<string, RequireTarget>();
  const targetsByResolvedId = new Map<string, RequireTarget>();
  let resolveDevImport: ReturnType<typeof createIdResolver> | undefined;
  let resolveDevRequire: ReturnType<typeof createIdResolver> | undefined;

  function targetForImporter(importer: string | undefined): RequireTarget | undefined {
    if (!importer) return undefined;
    return targetsByResolvedId.get(stripViteModuleQuery(importer));
  }

  return {
    name: "vinext:require-condition",
    enforce: "pre",

    configResolved(config) {
      resolveDevImport = createIdResolver(config, { isRequire: false, scan: true });
      resolveDevRequire = createIdResolver(config, { isRequire: true, scan: true });
    },

    async resolveId(source, importer, options) {
      const target = targetsByPublicId.get(source);
      if (target) {
        const id = `\0${source}`;
        targetsByResolvedId.set(id, target);
        return {
          id,
          moduleSideEffects: target.resolved.moduleSideEffects,
        };
      }

      const importerTarget = targetForImporter(importer);
      if (!importerTarget) return;
      return this.resolve(source, importerTarget.resolved.id, {
        kind: options.kind,
        custom: options.custom,
        isEntry: options.isEntry,
        skipSelf: true,
      });
    },

    load(id) {
      const target = targetsByResolvedId.get(stripViteModuleQuery(id));
      if (!target) return;
      this.addWatchFile(target.filePath);
      return fs.readFileSync(target.filePath, "utf8");
    },

    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:\?.*)?$/i,
        code: "require(",
      },
      async handler(code, id) {
        const importerTarget = targetForImporter(id);
        const realImporter = importerTarget?.resolved.id ?? id;
        const cleanId = stripViteModuleQuery(realImporter);
        if (!importerTarget && cleanId.includes("/node_modules/")) return;

        let ast: ReturnType<typeof parseAst>;
        try {
          ast = parseAst(code, { lang: parserLanguage(realImporter) });
        } catch {
          return;
        }

        const requires = collectStaticBareRequires(ast);
        if (requires.length === 0) return;

        const resolutions = await Promise.all(
          requires.map(async ({ specifier }) => {
            let [requireResolved, importResolved] = await Promise.all([
              this.resolve(specifier, realImporter, {
                kind: "require-call",
                skipSelf: true,
              }),
              this.resolve(specifier, realImporter, {
                kind: "import-statement",
                skipSelf: true,
              }),
            ]);

            // Dev dependency optimization is keyed by the bare specifier, so
            // both calls above can point at the same pre-bundled import entry
            // even when the unoptimized package exports differ. Compare with
            // Vite's internal non-optimizer resolver in that case.
            if (
              this.environment.mode === "dev" &&
              requireResolved?.id === importResolved?.id &&
              resolveDevImport &&
              resolveDevRequire
            ) {
              const [requireId, importId] = await Promise.all([
                resolveDevRequire(this.environment, specifier, realImporter),
                resolveDevImport(this.environment, specifier, realImporter),
              ]);
              if (requireId && importId && requireId !== importId) {
                requireResolved = {
                  external: false,
                  id: requireId,
                  meta: {},
                  moduleSideEffects: null,
                };
                importResolved = {
                  external: false,
                  id: importId,
                  meta: {},
                  moduleSideEffects: null,
                };
              }
            }

            if (
              !requireResolved ||
              !importResolved ||
              requireResolved.external ||
              requireResolved.id === importResolved.id
            ) {
              return null;
            }

            const filePath = stripViteModuleQuery(requireResolved.id);
            if (
              filePath.startsWith("\0") ||
              !path.isAbsolute(filePath) ||
              !SCRIPT_MODULE_RE.test(filePath) ||
              !fs.existsSync(filePath)
            ) {
              return null;
            }

            const publicId = virtualTargetId(requireResolved.id);
            targetsByPublicId.set(publicId, { filePath, resolved: requireResolved });
            return publicId;
          }),
        );

        let output: MagicString | undefined;
        for (let index = 0; index < requires.length; index++) {
          const publicId = resolutions[index];
          if (!publicId) continue;
          output ??= new MagicString(code);
          const request = requires[index];
          output.overwrite(request.argumentStart, request.argumentEnd, JSON.stringify(publicId));
        }

        if (!output) return;
        return {
          code: output.toString(),
          map: output.generateMap({ hires: "boundary" }),
        };
      },
    },
  };
}
