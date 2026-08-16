import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";
import {
  forEachAstChild,
  isAstRecord,
  mayContainDynamicImport,
  nodeArray,
  type AstRecord,
} from "./ast-utils.js";
import { stripViteModuleQuery } from "../utils/path.js";

type PagesNodeExternalsOptions = {
  getRoot: () => string;
  getPagesDir: () => string | null;
  getAliases: () => Readonly<Record<string, string>>;
  getTsconfigAliases: () => Readonly<Record<string, string>>;
  getBundledPackages: () => ReadonlySet<string>;
  isEnabled: () => boolean;
};

const FRAMEWORK_PACKAGES = new Set([
  "@vitejs/plugin-react",
  "@vitejs/plugin-rsc",
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "scheduler",
  "vite",
  "vinext",
]);

function packageNameFromSpecifier(id: string): string | null {
  const [first, second] = id.split("/");
  if (!first) return null;
  return first.startsWith("@") ? (second ? `${first}/${second}` : null) : first;
}

function canonicalFile(id: string): string {
  const cleanId = toSlash(stripViteModuleQuery(id));
  try {
    return toSlash(fs.realpathSync.native(cleanId));
  } catch {
    return cleanId;
  }
}

function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(canonicalFile(directory), canonicalFile(file));
  return (
    relative === "" ||
    (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative))
  );
}

function findPackageJson(file: string): string | null {
  let directory = path.dirname(file);
  while (true) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory || path.basename(directory) === "node_modules") return null;
    directory = parent;
  }
}

function canNodeImport(file: string): boolean {
  const extension = path.extname(file);
  if (extension === ".mjs") return true;
  if (extension !== ".js") return false;

  const packageJson = findPackageJson(file);
  if (!packageJson) return false;
  try {
    return (
      (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { type?: unknown }).type === "module"
    );
  } catch {
    return false;
  }
}

function matchesAlias(id: string, aliases: Readonly<Record<string, string>>): boolean {
  return Object.keys(aliases).some((alias) => id === alias || id.startsWith(`${alias}/`));
}

function parserLanguage(id: string): "js" | "jsx" | "ts" | "tsx" {
  const cleanId = stripViteModuleQuery(id).toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}

function moduleDependencySpecifiers(code: string, id: string): string[] {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: parserLanguage(id) });
  } catch {
    return [];
  }

  const specifiers: string[] = [];
  const seen = new Set<string>();
  const sourceSpecifier = (source: unknown): string | null => {
    if (!isAstRecord(source)) return null;
    if (source.type === "Literal") {
      return typeof source.value === "string" ? source.value : null;
    }
    if (source.type !== "TemplateLiteral" || nodeArray(source.expressions).length !== 0) {
      return null;
    }

    const quasis = nodeArray(source.quasis);
    if (quasis.length !== 1 || !isAstRecord(quasis[0]) || quasis[0].type !== "TemplateElement") {
      return null;
    }
    const value = quasis[0].value;
    if (typeof value !== "object" || value === null) return null;
    const cooked = Reflect.get(value, "cooked");
    const raw = Reflect.get(value, "raw");
    return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
  };
  const addStaticSource = (source: unknown): void => {
    const specifier = sourceSpecifier(source);
    if (specifier === null || seen.has(specifier)) return;
    seen.add(specifier);
    specifiers.push(specifier);
  };

  for (const statement of ast.body) {
    if (!isAstRecord(statement)) continue;
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      if (statement.importKind !== "type" && statement.exportKind !== "type") {
        addStaticSource(statement.source);
      }
    }
  }

  if (!mayContainDynamicImport(code)) return specifiers;

  const visitDynamicImports = (node: AstRecord): void => {
    if (node.type === "ImportExpression") {
      // Only statically known requests participate in the build graph. Never
      // guess at variable or interpolated dynamic imports.
      addStaticSource(node.source);
    }

    forEachAstChild(node, visitDynamicImports);
  };

  for (const statement of ast.body) {
    if (isAstRecord(statement)) visitDynamicImports(statement);
  }
  return specifiers;
}

/**
 * Externalize native ESM dependencies reached from Pages Router files.
 *
 * Next.js and Vite both resolve ESM imports through the package's `import`
 * condition. Keeping a native ESM entry external preserves that condition at
 * runtime and avoids traversing implementation-only dynamic imports during the
 * server build. A `.js` entry in a CommonJS package is deliberately left in
 * Vite's graph: Node cannot import it as ESM, while Rolldown can bundle the
 * selected `import` export just like Turbopack.
 */
export function createPagesNodeExternalsPlugin(options: PagesNodeExternalsOptions): Plugin {
  const pagesOwnedModulesByEnvironment = new Map<string, Set<string>>();
  const pagesOwnedModulesFor = (environmentName: string): Set<string> => {
    let modules = pagesOwnedModulesByEnvironment.get(environmentName);
    if (!modules) {
      modules = new Set<string>();
      pagesOwnedModulesByEnvironment.set(environmentName, modules);
    }
    return modules;
  };

  return {
    name: "vinext:pages-node-externals",
    // Vite's dev module runner resolves dependencies itself. Marking native
    // ESM packages external there bypasses its fixture/project resolver and
    // produces ERR_LOAD_URL; only production bundles need this external seam.
    apply: "build",
    enforce: "pre",
    applyToEnvironment(environment) {
      return (
        options.isEnabled() &&
        options.getPagesDir() !== null &&
        environment.name !== "client" &&
        environment.config.consumer !== "client"
      );
    },
    transform: {
      // Alias plugins resolve before user resolveId hooks, so follow static
      // import edges here while the original specifiers are still available.
      // This preserves Pages ownership through relative, tsconfig-path, and
      // other project-local imports before Rolldown traverses the module.
      filter: {
        id: {
          include: /\.[cm]?[jt]sx?(?:\?.*)?$/,
          exclude: /\/node_modules\//,
        },
      },
      async handler(code, id) {
        const environment = this.environment;
        if (!options.isEnabled() || !environment || environment.name === "client") return null;

        const pagesDir = options.getPagesDir();
        if (!pagesDir) return null;

        const cleanId = canonicalFile(id);
        if (!path.isAbsolute(cleanId) || cleanId.includes("/node_modules/")) {
          return null;
        }

        const pagesOwnedModules = pagesOwnedModulesFor(environment.name);
        if (!isInsideDirectory(pagesDir, cleanId) && !pagesOwnedModules.has(cleanId)) {
          return null;
        }

        pagesOwnedModules.add(cleanId);
        for (const specifier of moduleDependencySpecifiers(code, cleanId)) {
          const resolved = await this.resolve(specifier, id, { skipSelf: true });
          if (!resolved || resolved.external) continue;
          const resolvedFile = canonicalFile(resolved.id);
          if (path.isAbsolute(resolvedFile) && !resolvedFile.includes("/node_modules/")) {
            pagesOwnedModules.add(resolvedFile);
          }
        }
        return null;
      },
    },
    resolveId: {
      // Relative edges retain the cheap resolve-time ownership path, including
      // imports emitted by non-script transforms such as MDX. Bare requests
      // are resolved below both to seed local alias targets and to make the
      // final externalization decision.
      filter: { id: /^(?:\.\.?\/|(?![./\\]|[a-zA-Z][\w+.-]*:)[\w@])/ },
      async handler(id, importer) {
        const environment = this.environment;
        if (!options.isEnabled() || !environment || environment.name === "client" || !importer) {
          return null;
        }

        const pagesDir = options.getPagesDir();
        if (!pagesDir) return null;

        const pagesOwnedModules = pagesOwnedModulesFor(environment.name);
        const cleanImporter = canonicalFile(importer);
        const importerIsPagesOwned =
          path.isAbsolute(cleanImporter) &&
          (isInsideDirectory(pagesDir, cleanImporter) || pagesOwnedModules.has(cleanImporter));
        if (!importerIsPagesOwned) {
          return null;
        }

        if (id.startsWith(".")) {
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved && !resolved.external) {
            const resolvedFile = canonicalFile(resolved.id);
            if (path.isAbsolute(resolvedFile) && !resolvedFile.includes("/node_modules/")) {
              pagesOwnedModules.add(resolvedFile);
            }
          }
          return null;
        }

        const packageName = packageNameFromSpecifier(id);
        if (
          !packageName ||
          FRAMEWORK_PACKAGES.has(packageName) ||
          id === "next" ||
          id.startsWith("next/") ||
          id.startsWith("vinext/") ||
          id.startsWith("@vinext/") ||
          options.getBundledPackages().has(packageName)
        ) {
          return null;
        }

        if (
          matchesAlias(id, options.getAliases()) ||
          matchesAlias(id, options.getTsconfigAliases())
        ) {
          const aliased = await this.resolve(id, importer, { skipSelf: true });
          if (aliased && !aliased.external) {
            const aliasedFile = canonicalFile(aliased.id);
            if (path.isAbsolute(aliasedFile) && !aliasedFile.includes("/node_modules/")) {
              pagesOwnedModules.add(aliasedFile);
            }
          }
          return null;
        }

        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const resolvedFile = canonicalFile(resolved.id);
        if (!path.isAbsolute(resolvedFile)) return null;
        // Vite's native tsconfig/baseUrl resolver can resolve a bare-looking
        // request without materializing it in resolve.alias. Preserve Pages
        // ownership across that local edge before considering npm externals.
        if (!resolvedFile.includes("/node_modules/")) {
          pagesOwnedModules.add(resolvedFile);
          return null;
        }
        if (!canNodeImport(resolvedFile)) return null;

        // A nested dependency must stay bundled when resolving the same request
        // from the app root selects another installed version. External output
        // is relocated next to the root node_modules tree at runtime.
        const rootImporter = path.join(options.getRoot(), "__vinext_external_resolve__.js");
        const rootResolved = await this.resolve(id, rootImporter, { skipSelf: true });
        if (
          !rootResolved ||
          rootResolved.external ||
          canonicalFile(rootResolved.id) !== resolvedFile
        ) {
          return null;
        }

        return { id, external: true };
      },
    },
  };
}
