/**
 * Give stylesheets imported by both Server Components and Client Components a
 * single identity across the RSC and client production builds.
 *
 * Next.js compiles Server Component CSS in the client graph, so a stylesheet
 * imported by a layout and by a `next/dynamic()` client component is emitted
 * once and webpack's CSS loader never re-inserts it. `@vitejs/plugin-rsc`
 * compiles Server Component CSS in the RSC environment instead, so Rolldown
 * folds the shared stylesheet into both the layout's RSC asset and the client
 * chunk's asset. When the client chunk loads, Vite appends that second copy to
 * the end of <head> and it overrides every rule that should have followed it
 * (CSS Modules, page-level global CSS).
 *
 * Isolating each shared stylesheet into its own chunk in both builds gives it
 * the same content-hashed href in both places, so React's stylesheet resources
 * and Vite's preload helper dedupe the client copy by href. The isolated
 * stylesheet is also moved ahead of its importer's own CSS: Vite hoists pure
 * CSS chunks after the importer's CSS and plugin-rsc lists a chunk's own CSS
 * before its imports', both of which would put the dependency last.
 *
 * Ported behaviour: test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 */
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import { isCSSRequest, type Plugin, type ResolvedConfig, type Rollup } from "vite";

type ScanEnvironmentName = "rsc" | "ssr";

type ChunkWithCss = {
  imports: readonly string[];
  moduleIds: readonly string[];
  viteMetadata?: { importedCss: Set<string> };
};

const ISOLATED_ENVIRONMENTS = new Set(["rsc", "client"]);

function isStylesheetModuleId(id: string): boolean {
  return !id.startsWith("\0") && !id.includes("?") && isCSSRequest(id);
}

/**
 * Assign every shared stylesheet a unique, deterministic chunk name. Rolldown
 * merges modules that a `codeSplitting` name function maps to the same name,
 * so two `global.css` files in different directories must not collide. Both
 * builds see the same set, so both derive the same names.
 */
export function assignSharedCssChunkNames(ids: Iterable<string>): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...ids].sort()) {
    const base = path.basename(id).replace(/\.[^.]+$/, "") || "shared";
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
    used.add(name);
    names.set(id, name);
  }
  return names;
}

/**
 * Move the CSS of isolated shared-stylesheet chunks ahead of each importer's
 * own CSS. Covers both pure CSS chunks (already hoisted into the importer's
 * `importedCss` by Vite) and CSS Module chunks (still listed in `imports`).
 */
export function hoistIsolatedCss(
  bundle: Record<string, { type: string } & Partial<ChunkWithCss>>,
  isIsolatedChunk: (chunk: ChunkWithCss) => boolean,
  isolatedCssFiles: ReadonlySet<string>,
): void {
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    const chunk = output as ChunkWithCss & { type: "chunk" };
    const importedCss = chunk.viteMetadata?.importedCss;
    if (!importedCss || isIsolatedChunk(chunk)) continue;

    const dependencyCss: string[] = [];
    for (const importedFile of chunk.imports) {
      const imported = bundle[importedFile];
      if (imported?.type !== "chunk") continue;
      const importedChunk = imported as ChunkWithCss;
      if (!isIsolatedChunk(importedChunk)) continue;
      for (const file of importedChunk.viteMetadata?.importedCss ?? []) {
        if (isolatedCssFiles.has(file)) dependencyCss.push(file);
      }
    }
    for (const file of importedCss) {
      if (isolatedCssFiles.has(file)) dependencyCss.push(file);
    }
    if (dependencyCss.length === 0) continue;

    const ordered = new Set([...dependencyCss, ...importedCss]);
    importedCss.clear();
    for (const file of ordered) importedCss.add(file);
  }
}

export function createSharedCssChunks(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}) {
  const scannedStylesheets = new Map<ScanEnvironmentName, Set<string>>();
  let chunkNames = new Map<string, string>();
  const isolatedCssFilesByEnvironment = new Map<string, Set<string>>();

  function isIsolatedChunk(chunk: ChunkWithCss): boolean {
    return (
      chunk.moduleIds.length > 0 &&
      chunk.moduleIds.every(isStylesheetModuleId) &&
      chunk.moduleIds.some((id) => chunkNames.has(id))
    );
  }

  /**
   * Rolldown `codeSplitting` group for the RSC and client builds. The name
   * function runs during chunking, after the plugin-rsc scan builds have
   * populated the shared set, so the group is inert until then.
   */
  const codeSplittingGroup = {
    name(moduleId: string): string | null {
      return chunkNames.get(moduleId) ?? null;
    },
    // The client config's global `minSize` would otherwise drop tiny
    // stylesheets back into their importer's chunk.
    minSize: 0,
    priority: 100,
  };

  let config: ResolvedConfig;
  const plugin: Plugin = {
    name: "vinext:shared-css-chunks",
    apply: "build",
    // Run after vite:css-post has hoisted pure CSS chunks and before
    // vite:build-import-analysis reads `importedCss` for preload deps.
    enforce: "post",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async buildEnd() {
      const environmentName = this.environment.name;
      if (environmentName !== "rsc" && environmentName !== "ssr") return;
      const manager = await options.getManager(config);
      if (!manager?.isScanBuild) return;

      // plugin-rsc scans the RSC graph first, then the SSR graph (client
      // references). A new RSC scan starts a new build.
      if (environmentName === "rsc") {
        scannedStylesheets.clear();
        chunkNames = new Map();
        isolatedCssFilesByEnvironment.clear();
      }
      const stylesheets = new Set<string>();
      for (const id of this.getModuleIds()) {
        if (isStylesheetModuleId(id)) stylesheets.add(id);
      }
      scannedStylesheets.set(environmentName, stylesheets);

      const serverStylesheets = scannedStylesheets.get("rsc");
      const clientStylesheets = scannedStylesheets.get("ssr");
      if (!serverStylesheets || !clientStylesheets) return;
      const shared: string[] = [];
      for (const id of serverStylesheets) {
        if (clientStylesheets.has(id)) shared.push(id);
      }
      chunkNames = assignSharedCssChunkNames(shared);
    },
    renderChunk(_code, chunk) {
      if (chunkNames.size === 0 || !ISOLATED_ENVIRONMENTS.has(this.environment.name)) return null;
      if (!isIsolatedChunk(chunk)) return null;
      let files = isolatedCssFilesByEnvironment.get(this.environment.name);
      if (!files) {
        files = new Set();
        isolatedCssFilesByEnvironment.set(this.environment.name, files);
      }
      for (const file of chunk.viteMetadata?.importedCss ?? []) files.add(file);
      return null;
    },
    generateBundle(_options, bundle: Rollup.OutputBundle) {
      const files = isolatedCssFilesByEnvironment.get(this.environment.name);
      if (!files || files.size === 0) return;
      hoistIsolatedCss(bundle, isIsolatedChunk, files);
    },
  };

  return { codeSplittingGroup, plugin };
}
