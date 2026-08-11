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
          const chunkImports = new Map<string, string[]>();
          for (const moduleId of chunkModuleIds) {
            chunkImports.set(
              moduleId,
              (this.getModuleInfo(moduleId)?.importedIds ?? []).filter((importedId) =>
                chunkModuleSet.has(importedId),
              ),
            );
          }

          // Condense cycles before selecting roots. A strongly connected
          // component has no ordinary in-chunk root, so starting from Rollup's
          // chunk.modules render order can reverse ESM evaluation order. Pick
          // the SCC member imported from outside this chunk instead, then let
          // the normal source-order DFS walk the cycle from that entry point.
          const components = stronglyConnectedComponents(chunkModuleIds, chunkImports);
          const componentByModule = new Map<string, number>();
          components.forEach((component, index) => {
            for (const moduleId of component) componentByModule.set(moduleId, index);
          });
          const componentIndegree = components.map(() => 0);
          for (const [moduleId, importedIds] of chunkImports) {
            const from = componentByModule.get(moduleId);
            for (const importedId of importedIds) {
              const to = componentByModule.get(importedId);
              if (from !== undefined && to !== undefined && from !== to) componentIndegree[to]++;
            }
          }
          const componentEntries = components.map((component) => {
            const externalEntries = component.filter((moduleId) =>
              (this.getModuleInfo(moduleId)?.importers ?? []).some(
                (importer) => !chunkModuleSet.has(importer),
              ),
            );
            return [...(externalEntries.length > 0 ? externalEntries : component)].sort()[0];
          });
          const rootComponents = components
            .map((_, index) => index)
            .filter((index) => componentIndegree[index] === 0)
            .sort((a, b) => componentEntries[a].localeCompare(componentEntries[b]));
          for (const componentIndex of rootComponents) {
            collectModuleCss(componentEntries[componentIndex]);
          }
          if (orderedCss.length === 0) continue;
          add(currentCss);
          metadata.importedCss = new Set(orderedCss);
        }
      },
    },
  };
}

function stronglyConnectedComponents(
  moduleIds: string[],
  imports: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (moduleId: string) => {
    const index = nextIndex++;
    indices.set(moduleId, index);
    lowLinks.set(moduleId, index);
    stack.push(moduleId);
    onStack.add(moduleId);

    for (const importedId of imports.get(moduleId) ?? []) {
      if (!indices.has(importedId)) {
        visit(importedId);
        lowLinks.set(moduleId, Math.min(lowLinks.get(moduleId)!, lowLinks.get(importedId)!));
      } else if (onStack.has(importedId)) {
        lowLinks.set(moduleId, Math.min(lowLinks.get(moduleId)!, indices.get(importedId)!));
      }
    }

    if (lowLinks.get(moduleId) !== index) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === moduleId) break;
    }
    components.push(component);
  };

  for (const moduleId of [...moduleIds].sort()) {
    if (!indices.has(moduleId)) visit(moduleId);
  }
  return components;
}
