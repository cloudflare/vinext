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

type CssOwner = { key: string; source: string };

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
 * both environments emit the same CSS asset href. CSS modules retain Vite's
 * normal chunking; only the cross-environment global resource needs a stable
 * owner for React to dedupe it.
 */
export function appGlobalCssOwnerChunkName(id: string): string | null {
  const owner = decodeOwnerId(id);
  if (!owner) return null;
  const digest = createHash("sha256").update(owner.key).digest("hex").slice(0, 8);
  return `app-global-css-${digest}`;
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
        if (source.includes("?") && !/[?&]vite-rsc-css-export(?:[=&]|$)/.test(source)) return null;

        const appDir = getAppDir();
        if (!appDir) return null;
        const cleanImporter = cleanModuleId(importer);
        if (!isInsideDirectory(appDir, cleanImporter)) return null;

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const resolvedId = toSlash(resolved.id);
        if (!GLOBAL_STYLESHEET_RE.test(cleanModuleId(resolvedId))) return null;
        if (cleanModuleId(resolvedId).includes(".module.")) return null;
        const ownerKey = path.relative(appDir, cleanModuleId(resolvedId));
        return encodeOwnerId({ key: ownerKey, source: resolvedId });
      },
    },
    load: {
      filter: { id: /vinext:app-global-css:/ },
      handler(id) {
        const owner = decodeOwnerId(id);
        if (!owner) return null;
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
          let addedLocalCss = false;
          for (const moduleId of Object.keys(chunk.modules ?? {})) {
            const importedIds = this.getModuleInfo(moduleId)?.importedIds ?? [];
            for (const importedId of importedIds) {
              const importedOwnerCss = ownerCss.get(importedId);
              if (importedOwnerCss) {
                hasOwnerImport = true;
                add(importedOwnerCss);
                continue;
              }
              if (!addedLocalCss && GLOBAL_STYLESHEET_RE.test(cleanModuleId(importedId))) {
                add(currentCss);
                addedLocalCss = true;
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
