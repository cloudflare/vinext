import { createHash } from "node:crypto";
import path, { toSlash } from "pathslash";
import type { Plugin } from "vite";
import type { BundleBackfillChunk } from "../build/ssr-manifest.js";

const APP_GLOBAL_CSS_OWNER_PREFIX = "\0vinext:app-global-css:";
const APP_GLOBAL_CSS_OWNER_SUFFIX = ".js";
const APP_GLOBAL_CSS_SOURCE_QUERY = "vinext-app-global-css-source";
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
 * modules get owners as well. That lets the server-resource manifest preserve
 * their graph-wide order across global boundaries without changing normal
 * client CSS chunking.
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
        if (source.includes("?") && !/[?&]vite-rsc-css-export(?:[=&]|$)/.test(source)) {
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
        if (isModule && this.environment?.name !== "rsc") return null;
        const ownerKey = path.relative(appDir, cleanModuleId(resolvedId));
        return encodeOwnerId({
          key: ownerKey,
          kind: isModule ? "module" : "global",
          source: resolvedId,
        });
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

          const visitedModules = new Set<string>();
          const collectModuleCss = (moduleId: string) => {
            if (visitedModules.has(moduleId)) return;
            visitedModules.add(moduleId);
            const importedOwnerCss = ownerCss.get(moduleId);
            if (importedOwnerCss) {
              add(importedOwnerCss);
              return;
            }
            for (const importedId of this.getModuleInfo(moduleId)?.importedIds ?? []) {
              collectModuleCss(importedId);
            }
          };
          const chunkModuleIds = Object.keys(chunk.modules ?? {});
          const chunkModuleSet = new Set(chunkModuleIds);
          const importedWithinChunk = new Set<string>();
          for (const moduleId of chunkModuleIds) {
            for (const importedId of this.getModuleInfo(moduleId)?.importedIds ?? []) {
              if (chunkModuleSet.has(importedId)) importedWithinChunk.add(importedId);
            }
          }
          for (const moduleId of chunkModuleIds) {
            if (!importedWithinChunk.has(moduleId)) collectModuleCss(moduleId);
          }
          // Cyclic components have no graph root. Walk any unvisited modules
          // afterward so their CSS is retained with the bundle's stable order.
          for (const moduleId of chunkModuleIds) collectModuleCss(moduleId);
          if (orderedCss.length === 0) continue;
          add(currentCss);
          metadata.importedCss = new Set(orderedCss);
        }
      },
    },
  };
}
