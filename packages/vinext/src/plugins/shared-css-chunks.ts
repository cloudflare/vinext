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
 * Each shared stylesheet is isolated into its own chunk in both builds, and the
 * client chunk reuses the CSS file the RSC build emitted for it, so both sides
 * reference one href and React's stylesheet resources and Vite's preload
 * helper dedupe the client copy by href.
 *
 * Splitting a stylesheet out of its importer's CSS must not change the
 * cascade. Vite lists a chunk's own CSS file before the CSS of the chunks it
 * imports, so the isolated file would otherwise always follow the importer's
 * remaining CSS. Instead, every stylesheet that precedes an isolated one in
 * some module's import order is isolated too (in that build only), so a
 * chunk's remaining CSS only ever holds stylesheets that come after all of its
 * isolated ones. The isolated files are then listed first, in the importer's
 * import order. When every shared stylesheet is imported first, nothing else
 * is split out.
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

/** Per-module stylesheet order: the stylesheets it reaches, in import order. */
type StylesheetOrders = ReadonlyMap<string, readonly string[]>;

const EMPTY: readonly string[] = [];

function isStylesheetModuleId(id: string): boolean {
  return !id.startsWith("\0") && !id.includes("?") && isCSSRequest(id);
}

/**
 * Assign every isolated stylesheet a unique, deterministic chunk name. Rolldown
 * merges modules that a `codeSplitting` name function maps to the same name,
 * so two `global.css` files in different directories must not collide. Both
 * builds see the same shared set, so both derive the same names for it;
 * `reserved` keeps build-specific additions from taking one of those names.
 */
export function assignSharedCssChunkNames(
  ids: Iterable<string>,
  reserved: Iterable<string> = [],
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>(reserved);
  for (const id of [...ids].sort()) {
    const base = path.basename(id).replace(/\.[^.]+$/, "") || "shared";
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
    used.add(name);
    names.set(id, name);
  }
  return names;
}

function mergeStylesheetOrders(
  lists: readonly (readonly string[])[],
  own: string | undefined,
): readonly string[] {
  if (own === undefined) {
    const nonEmpty = lists.filter((list) => list.length > 0);
    if (nonEmpty.length === 0) return EMPTY;
    if (nonEmpty.length === 1) return nonEmpty[0];
  }
  const merged = new Set<string>();
  for (const list of lists) for (const id of list) merged.add(id);
  if (own !== undefined) merged.add(own);
  return [...merged];
}

/**
 * For every module, the stylesheets it reaches through static imports in the
 * order they evaluate (depth-first, imports in source order, each stylesheet
 * at its first occurrence). This is the order a chunk's CSS is concatenated
 * in. Import cycles are cut at the back edge.
 */
export function computeStylesheetOrders(
  moduleIds: Iterable<string>,
  getImportedIds: (id: string) => readonly string[],
): Map<string, readonly string[]> {
  const orders = new Map<string, readonly string[]>();
  const visiting = new Set<string>();
  type Frame = { id: string; imports: readonly string[]; next: number };
  for (const root of moduleIds) {
    if (orders.has(root) || visiting.has(root)) continue;
    const stack: Frame[] = [{ id: root, imports: getImportedIds(root), next: 0 }];
    visiting.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next < frame.imports.length) {
        const imported = frame.imports[frame.next++];
        if (!orders.has(imported) && !visiting.has(imported)) {
          visiting.add(imported);
          stack.push({ id: imported, imports: getImportedIds(imported), next: 0 });
        }
        continue;
      }
      stack.pop();
      visiting.delete(frame.id);
      orders.set(
        frame.id,
        mergeStylesheetOrders(
          frame.imports.map((imported) => orders.get(imported) ?? EMPTY),
          isStylesheetModuleId(frame.id) ? frame.id : undefined,
        ),
      );
    }
  }
  return orders;
}

/**
 * Grow `isolated` until, in every module's stylesheet order, each isolated
 * stylesheet precedes every stylesheet that is not. A chunk's remaining CSS
 * then never contains a stylesheet that should come before one it hoists.
 */
export function expandIsolatedStylesheets(
  orders: StylesheetOrders,
  isolated: Iterable<string>,
): Set<string> {
  const result = new Set(isolated);
  const lists = new Set<readonly string[]>();
  for (const list of orders.values()) if (list.length > 1) lists.add(list);
  let changed = result.size > 0;
  while (changed) {
    changed = false;
    for (const list of lists) {
      let last = -1;
      for (let index = list.length - 1; index >= 0; index--) {
        if (result.has(list[index])) {
          last = index;
          break;
        }
      }
      for (let index = 0; index < last; index++) {
        if (result.has(list[index])) continue;
        result.add(list[index]);
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Put the CSS of isolated stylesheet chunks ahead of each importer's own CSS,
 * in the importer's import order. Covers both pure CSS chunks (already hoisted
 * into the importer's `importedCss` by Vite) and CSS Module chunks (still
 * listed in `imports`). `isolatedCssFiles` maps each isolated CSS file to its
 * stylesheet module id; `getStylesheetOrder` gives a chunk's stylesheet order.
 */
export function hoistIsolatedCss(
  bundle: Record<string, { type: string } & Partial<ChunkWithCss>>,
  isIsolatedChunk: (chunk: ChunkWithCss) => boolean,
  isolatedCssFiles: ReadonlyMap<string, string>,
  getStylesheetOrder: (chunk: ChunkWithCss) => readonly string[],
): void {
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    const chunk = output as ChunkWithCss & { type: "chunk" };
    const importedCss = chunk.viteMetadata?.importedCss;
    if (!importedCss || isIsolatedChunk(chunk)) continue;

    const dependencyCss = new Set<string>();
    for (const importedFile of chunk.imports) {
      const imported = bundle[importedFile];
      if (imported?.type !== "chunk") continue;
      const importedChunk = imported as ChunkWithCss;
      if (!isIsolatedChunk(importedChunk)) continue;
      for (const file of importedChunk.viteMetadata?.importedCss ?? []) {
        if (isolatedCssFiles.has(file)) dependencyCss.add(file);
      }
    }
    for (const file of importedCss) {
      if (isolatedCssFiles.has(file)) dependencyCss.add(file);
    }
    if (dependencyCss.size === 0) continue;

    const positions = new Map<string, number>();
    for (const id of getStylesheetOrder(chunk)) positions.set(id, positions.size);
    const position = (file: string) =>
      positions.get(isolatedCssFiles.get(file) ?? "") ?? Number.POSITIVE_INFINITY;
    // Array#sort is stable, so files without a known position keep their order.
    const ordered = new Set([
      ...[...dependencyCss].sort((a, b) => position(a) - position(b)),
      ...importedCss,
    ]);
    importedCss.clear();
    for (const file of ordered) importedCss.add(file);
  }
}

/** Replace a chunk's CSS files with `files`, recording the ones dropped. */
function replaceCssFiles(
  importedCss: Set<string>,
  files: readonly string[] | undefined,
  replaced: Set<string>,
): void {
  if (!files || files.length === 0) return;
  if (importedCss.size === files.length && files.every((file) => importedCss.has(file))) return;
  for (const file of importedCss) {
    if (!files.includes(file)) replaced.add(file);
  }
  importedCss.clear();
  for (const file of files) importedCss.add(file);
}

/** Drop replaced CSS assets that no chunk references any more. */
function deleteUnreferencedCssAssets(
  bundle: Record<string, { type: string } & Partial<ChunkWithCss>>,
  candidates: ReadonlySet<string>,
): void {
  if (candidates.size === 0) return;
  const referenced = new Set<string>();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const file of output.viteMetadata?.importedCss ?? []) referenced.add(file);
  }
  for (const file of candidates) {
    if (!referenced.has(file) && bundle[file]?.type === "asset") delete bundle[file];
  }
}

/** State for the RSC or client build currently being bundled. */
type IsolationBuild = {
  environmentName: "rsc" | "client";
  chunkNames: ReadonlyMap<string, string>;
  stylesheetOrders: StylesheetOrders;
  /** Isolated CSS file → the stylesheet module it was emitted for. */
  cssFileModules: Map<string, string>;
};

export function createSharedCssChunks(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}) {
  const scannedStylesheets = new Map<ScanEnvironmentName, Set<string>>();
  // Stylesheets imported from both graphs, with names shared by both builds.
  let sharedChunkNames = new Map<string, string>();
  let activeBuild: IsolationBuild | undefined;
  // CSS files the RSC build emitted for each shared stylesheet.
  const rscSharedCss = new Map<string, readonly string[]>();
  // Client CSS assets replaced by their RSC counterparts.
  const replacedClientCss = new Set<string>();

  function getIsolatedModuleId(chunk: ChunkWithCss): string | undefined {
    const chunkNames = activeBuild?.chunkNames;
    if (!chunkNames || chunk.moduleIds.length === 0) return undefined;
    if (!chunk.moduleIds.every(isStylesheetModuleId)) return undefined;
    return chunk.moduleIds.find((id) => chunkNames.has(id));
  }

  function isIsolatedChunk(chunk: ChunkWithCss): boolean {
    return getIsolatedModuleId(chunk) !== undefined;
  }

  function getChunkStylesheetOrder(chunk: ChunkWithCss): readonly string[] {
    const orders = activeBuild?.stylesheetOrders;
    if (!orders) return EMPTY;
    // Chunk modules are in evaluation order, so merging their orders gives
    // the order the chunk's stylesheets would have been concatenated in.
    return mergeStylesheetOrders(
      chunk.moduleIds.map((id) => orders.get(id) ?? EMPTY),
      undefined,
    );
  }

  /**
   * Rolldown `codeSplitting` group for the RSC and client builds. The name
   * function runs during chunking, after `buildEnd` has chosen the isolated
   * stylesheets for that build, so the group is inert until then.
   */
  const codeSplittingGroup = {
    name(moduleId: string): string | null {
      return activeBuild?.chunkNames.get(moduleId) ?? null;
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
      if (environmentName !== "rsc" && environmentName !== "ssr" && environmentName !== "client") {
        return;
      }
      const manager = await options.getManager(config);
      if (!manager) return;

      if (manager.isScanBuild) {
        if (environmentName === "client") return;
        // plugin-rsc scans the RSC graph first, then the SSR graph (client
        // references). A new RSC scan starts a new build.
        if (environmentName === "rsc") {
          scannedStylesheets.clear();
          sharedChunkNames = new Map();
          activeBuild = undefined;
          rscSharedCss.clear();
          replacedClientCss.clear();
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
        sharedChunkNames = assignSharedCssChunkNames(shared);
        return;
      }

      activeBuild = undefined;
      if (environmentName === "ssr" || sharedChunkNames.size === 0) return;
      if (environmentName === "rsc") {
        rscSharedCss.clear();
        replacedClientCss.clear();
      }

      // Chunking has not happened yet, so decide what to isolate from this
      // build's own module graph.
      const stylesheetOrders = computeStylesheetOrders(
        this.getModuleIds(),
        (id) => this.getModuleInfo(id)?.importedIds ?? EMPTY,
      );
      const shared = [...sharedChunkNames.keys()].filter((id) => stylesheetOrders.has(id));
      const isolated = expandIsolatedStylesheets(stylesheetOrders, shared);
      const additions = [...isolated].filter((id) => !sharedChunkNames.has(id));
      const chunkNames = new Map(sharedChunkNames);
      for (const [id, name] of assignSharedCssChunkNames(additions, sharedChunkNames.values())) {
        chunkNames.set(id, name);
      }
      activeBuild = { environmentName, chunkNames, stylesheetOrders, cssFileModules: new Map() };
    },
    renderChunk(_code, chunk) {
      const build = activeBuild;
      if (!build || build.environmentName !== this.environment.name) return null;
      const moduleId = getIsolatedModuleId(chunk);
      const importedCss = chunk.viteMetadata?.importedCss;
      if (moduleId === undefined || !importedCss) return null;

      if (sharedChunkNames.has(moduleId)) {
        if (build.environmentName === "rsc") {
          rscSharedCss.set(moduleId, [...importedCss]);
        } else {
          // plugin-rsc builds the RSC environment first and copies its CSS
          // into the client output. Point the client chunk at that file so
          // both sides share one href even when the environments compile the
          // stylesheet differently (e.g. only the client build disables asset
          // inlining, so a small url() asset becomes a data URL in the RSC
          // copy alone). Swapping here, before vite:css-post and plugin-rsc
          // read `importedCss` in generateBundle, keeps every consumer
          // consistent.
          replaceCssFiles(importedCss, rscSharedCss.get(moduleId), replacedClientCss);
        }
      }
      for (const file of importedCss) build.cssFileModules.set(file, moduleId);
      return null;
    },
    generateBundle(_options, bundle: Rollup.OutputBundle) {
      const build = activeBuild;
      if (!build || build.environmentName !== this.environment.name) return;
      if (build.environmentName === "client") {
        deleteUnreferencedCssAssets(bundle, replacedClientCss);
      }
      if (build.cssFileModules.size === 0) return;
      hoistIsolatedCss(bundle, isIsolatedChunk, build.cssFileModules, getChunkStylesheetOrder);
    },
  };

  return { codeSplittingGroup, plugin };
}
