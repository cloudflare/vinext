import fs from "node:fs";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { createIdResolver, type Plugin, type Rollup } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

type ExternalModuleMode = "import" | "require";

const BARE_PACKAGE_SPECIFIER_RE =
  /^(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9_~-][A-Za-z0-9._~-]*)(?:\/[^?#]*)?$/;

function realpath(resolvedPath: string): string {
  try {
    return toSlash(fs.realpathSync.native(resolvedPath));
  } catch {
    return toSlash(resolvedPath);
  }
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0] || null;
}

function moduleMode(kind: Rollup.ImportKind | undefined): ExternalModuleMode {
  return kind === "require-call" ? "require" : "import";
}

/**
 * Compare the package instance selected from an importer with the instance
 * selected from the project root. A differing importer resolution must be
 * bundled so relocating the server output cannot collapse both imports to the
 * same root-level package.
 */
function compareTransitiveExternalResolutions(
  importerResolution: string,
  rootResolution: string | null,
): string | null {
  const importerRealpath = realpath(importerResolution);
  if (!rootResolution) return importerRealpath;
  return importerRealpath === realpath(rootResolution) ? null : importerRealpath;
}

/**
 * CommonJS fallback used when Vite cannot resolve a require-call with its
 * conditions-aware resolver.
 */
function resolveTransitiveExternal(
  request: string,
  importer: string,
  rootResolver: NodeRequire,
): string | null {
  let importerResolution: string;
  try {
    importerResolution = createRequire(importer).resolve(request);
  } catch {
    return null;
  }

  let rootResolution: string | null = null;
  try {
    rootResolution = rootResolver.resolve(request);
  } catch {
    // The importer-only package must be bundled or it will not exist beside a
    // relocated server bundle at runtime.
  }

  return compareTransitiveExternalResolutions(importerResolution, rootResolution);
}

/**
 * Mirrors the path-equality portion of Next.js's `baseResolveCheck` for
 * `serverExternalPackages`.
 *
 * A bare external imported by a dependency is only safe to leave external
 * when resolving it from the dependency selects the same installed package as
 * resolving it from the project root. Otherwise this hook returns the
 * importer's absolute resolution, forcing Vite to bundle that nested copy.
 *
 * Next.js separately compares its resolver's CommonJS/ESM classification.
 * Vite instead selects an import- or require-configured resolver up front;
 * once both contexts select the same absolute file, its format follows that
 * file and package scope rather than the importer context.
 *
 * Reference: packages/next/src/build/handle-externals.ts in Next.js.
 */
export function createTransitiveExternalsPlugin(options: {
  getRoot: () => string | undefined;
  getExternalPackages: () => readonly string[];
}): Plugin {
  let externalPackages: Set<string> | undefined;
  let rootImporter: string | undefined;
  let rootResolver: NodeRequire | undefined;
  let importResolver: ReturnType<typeof createIdResolver> | undefined;
  let requireResolver: ReturnType<typeof createIdResolver> | undefined;

  return {
    name: "vinext:transitive-externals",
    apply: "build",
    enforce: "pre",
    applyToEnvironment(environment) {
      return environment.name !== "client" && environment.config.consumer !== "client";
    },

    configResolved(config) {
      const root = options.getRoot();
      if (!root) return;
      externalPackages = new Set(options.getExternalPackages());
      rootImporter = path.join(root, "package.json");
      rootResolver = createRequire(rootImporter);
      importResolver = createIdResolver(config, {
        external: [],
        isRequire: false,
        noExternal: true,
      });
      requireResolver = createIdResolver(config, {
        external: [],
        isRequire: true,
        noExternal: true,
      });
    },

    resolveId: {
      filter: { id: BARE_PACKAGE_SPECIFIER_RE },
      handler(source, importer, resolveOptions) {
        if (
          !importer ||
          !externalPackages ||
          externalPackages.size === 0 ||
          !rootImporter ||
          !rootResolver ||
          !importResolver ||
          !requireResolver
        ) {
          return null;
        }

        const packageName = packageNameFromSpecifier(source);
        if (!packageName || !externalPackages.has(packageName)) return null;
        if (importer.startsWith("\0")) return null;
        const cleanImporter = stripViteModuleQuery(importer);
        if (!path.isAbsolute(cleanImporter)) return null;

        const mode = moduleMode(resolveOptions.kind);
        const resolver = mode === "require" ? requireResolver : importResolver;
        return (async () => {
          const importerResolution = await resolver(this.environment, source, cleanImporter);
          if (!importerResolution || !path.isAbsolute(importerResolution)) {
            // Node's resolver models require() accurately, but must not be used
            // for ESM imports because doing so can select a require-only export.
            return mode === "require"
              ? resolveTransitiveExternal(source, cleanImporter, rootResolver)
              : null;
          }

          const rootResolution = await resolver(this.environment, source, rootImporter);
          return compareTransitiveExternalResolutions(
            importerResolution,
            rootResolution && path.isAbsolute(rootResolution) ? rootResolution : null,
          );
        })();
      },
    },
  };
}
