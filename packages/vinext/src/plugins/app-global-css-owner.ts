import { createHash } from "node:crypto";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";
import type { BundleBackfillChunk } from "../build/ssr-manifest.js";

const APP_GLOBAL_CSS_OWNER_PREFIX = "\0vinext:app-global-css:";
const APP_GLOBAL_CSS_OWNER_SUFFIX = ".js";
const APP_GLOBAL_CSS_SOURCE_QUERY = "vinext-app-global-css-source";
const CSS_MODULE_OWNER_QUERY = "vinext-app-css-module-owner";
const GLOBAL_STYLESHEET_RE = /\.(?:css|scss|sass)$/i;
const GLOBAL_STYLESHEET_CANDIDATE_RE =
  /(?:\.(?:css|scss|sass)(?:\?|$)|^[^?]*\/(?:[^./?]+)$|^[^./?]+$)/i;

function cleanModuleId(id: string): string {
  return toSlash(id.split("?", 1)[0] ?? id);
}

function isInsideDirectory(directory: string, id: string): boolean {
  const relative = path.relative(directory, id);
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

type CssOwner = { key: string; kind: "global" | "module"; source: string };

type StaticImportNode = {
  type: "ImportDeclaration";
  source: { end: number; start: number; value: unknown };
};

function staticImports(source: string, id: string): StaticImportNode[] {
  const extension = path.extname(cleanModuleId(id)).slice(1).toLowerCase();
  const lang =
    extension === "tsx" || extension === "jsx" ? extension : extension === "ts" ? "ts" : "js";
  try {
    const ast = parseAst(source, { lang });
    return ast.body.flatMap((node) => {
      if (node.type !== "ImportDeclaration") return [];
      const value = (node as StaticImportNode).source.value;
      return typeof value === "string" ? [node as StaticImportNode] : [];
    });
  } catch {
    return [];
  }
}

function encodeOwnerId(owner: CssOwner): string {
  return (
    APP_GLOBAL_CSS_OWNER_PREFIX +
    encodeURIComponent(JSON.stringify(owner)) +
    APP_GLOBAL_CSS_OWNER_SUFFIX
  );
}

function appendSourceQuery(source: string): string {
  return `${source}${source.includes("?") ? "&" : "?"}${APP_GLOBAL_CSS_SOURCE_QUERY}`;
}

function decodeOwnerId(id: string): CssOwner | null {
  if (!id.startsWith(APP_GLOBAL_CSS_OWNER_PREFIX) || !id.endsWith(APP_GLOBAL_CSS_OWNER_SUFFIX)) {
    return null;
  }
  const encoded = id.slice(APP_GLOBAL_CSS_OWNER_PREFIX.length, -APP_GLOBAL_CSS_OWNER_SUFFIX.length);
  return JSON.parse(decodeURIComponent(encoded)) as CssOwner;
}

/**
 * Keep one build chunk per App Router stylesheet that needs stable ownership.
 *
 * Global stylesheets use the owner in both RSC and client-reference builds so
 * both environments emit the same CSS asset href. In the RSC build, CSS
 * modules in an importer that mixes module and global styles also get owners.
 * That lets the server-resource manifest preserve order across each global
 * boundary without changing normal client CSS chunking.
 */
export function appGlobalCssOwnerChunkName(id: string): string | null {
  const owner = decodeOwnerId(id);
  if (!owner) return null;
  const digest = createHash("sha256").update(owner.key).digest("hex").slice(0, 8);
  return owner.kind === "module" ? `app-css-module-${digest}` : `app-global-css-${digest}`;
}

export function createAppGlobalCssOwnerPlugin(getAppDir: () => string | null): Plugin {
  return {
    name: "vinext:app-global-css-owner",
    apply: "build",
    enforce: "pre",
    resolveId: {
      // Extensionless aliases and package exports can resolve to CSS, so let
      // those candidates reach Vite's resolver before deciding whether they
      // need an owner. The native filter still excludes explicit non-CSS file
      // extensions from this build-only hook.
      filter: { id: GLOBAL_STYLESHEET_CANDIDATE_RE },
      async handler(source, importer) {
        if (!importer) return null;
        if (
          source.includes("?") &&
          !/[?&](?:vite-rsc-css-export|vinext-app-css-module-owner)(?:[=&]|$)/.test(source)
        ) {
          return null;
        }

        const appDir = getAppDir();
        if (!appDir) return null;
        const cleanImporter = cleanModuleId(importer);
        if (!isInsideDirectory(appDir, cleanImporter)) return null;

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const resolvedId = toSlash(resolved.id);
        if (!GLOBAL_STYLESHEET_RE.test(cleanModuleId(resolvedId))) return null;
        const isModule = cleanModuleId(resolvedId).includes(".module.");
        if (isModule && !source.includes(CSS_MODULE_OWNER_QUERY)) return null;
        const ownerKey = path.relative(appDir, cleanModuleId(resolvedId));
        return encodeOwnerId({
          key: ownerKey,
          kind: isModule ? "module" : "global",
          source: resolvedId,
        });
      },
    },
    transform: {
      filter: { id: /\.[jt]sx?$/, code: /\.module\.(?:css|scss|sass)/i },
      async handler(code, id) {
        if (this.environment?.name !== "rsc") return null;
        const appDir = getAppDir();
        const cleanId = cleanModuleId(id);
        if (!appDir || !isInsideDirectory(appDir, cleanId)) return null;

        const imports = staticImports(code, id);
        const stylesheets: Array<{
          importNode: StaticImportNode;
          isModule: boolean;
        }> = [];
        for (const importNode of imports) {
          const specifier = String(importNode.source.value);
          const resolved = await this.resolve(specifier, id, { skipSelf: true });
          if (!resolved || resolved.external) continue;
          const resolvedId = cleanModuleId(resolved.id);
          if (!GLOBAL_STYLESHEET_RE.test(resolvedId)) continue;
          stylesheets.push({ importNode, isModule: resolvedId.includes(".module.") });
        }
        if (!stylesheets.some(({ isModule }) => isModule)) return null;
        if (!stylesheets.some(({ isModule }) => !isModule)) return null;

        const output = new MagicString(code);
        for (const { importNode, isModule } of stylesheets) {
          if (!isModule) continue;
          const specifier = String(importNode.source.value);
          output.update(
            importNode.source.start,
            importNode.source.end,
            JSON.stringify(
              `${specifier}${specifier.includes("?") ? "&" : "?"}${CSS_MODULE_OWNER_QUERY}`,
            ),
          );
        }
        return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
      },
    },
    load: {
      filter: { id: /vinext:app-global-css:/ },
      handler(id) {
        const owner = decodeOwnerId(id);
        if (!owner) return null;
        if (owner.kind === "module") {
          const source = JSON.stringify(appendSourceQuery(owner.source));
          return `export { default } from ${source};\nexport * from ${source};\nglobalThis[Symbol.for("vinext.css.owner")];`;
        }
        return `import ${JSON.stringify(appendSourceQuery(owner.source))};\nglobalThis[Symbol.for("vinext.css.owner")];`;
      },
    },
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        if (this.environment?.name !== "rsc") return;

        const chunks = Object.values(bundle).filter(
          (output): output is typeof output & BundleBackfillChunk => output.type === "chunk",
        );
        const ownerCss = new Map<string, string[]>();
        for (const chunk of chunks) {
          const css = [...(chunk.viteMetadata?.importedCss ?? [])];
          if (css.length === 0) continue;
          for (const moduleId of Object.keys(chunk.modules ?? {})) {
            if (decodeOwnerId(moduleId)) ownerCss.set(moduleId, css);
          }
        }

        for (const chunk of chunks) {
          const metadata = chunk.viteMetadata;
          if (!metadata) continue;
          const currentCss = [...(metadata.importedCss ?? [])];
          const orderedCss: string[] = [];
          const seen = new Set<string>();
          const add = (files: Iterable<string>) => {
            for (const file of files) {
              if (seen.has(file)) continue;
              seen.add(file);
              orderedCss.push(file);
            }
          };

          let hasOwnerImport = false;
          for (const moduleId of Object.keys(chunk.modules ?? {})) {
            const importedIds = this.getModuleInfo(moduleId)?.importedIds ?? [];
            for (const importedId of importedIds) {
              const importedOwnerCss = ownerCss.get(importedId);
              if (importedOwnerCss) {
                hasOwnerImport = true;
                add(importedOwnerCss);
              }
            }
          }
          if (!hasOwnerImport) continue;
          add(currentCss);
          metadata.importedCss = new Set(orderedCss);
        }
      },
    },
  };
}
