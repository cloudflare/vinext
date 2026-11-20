import path from "pathslash";

type BundleItem = {
  type: string;
  fileName: string;
  facadeModuleId?: string | null;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  viteMetadata?: { importedCss?: ReadonlySet<string> };
};

type CollectPagesPageStylesheetsOptions = {
  /** The route that a page module renders, such as "/posts/[id]". */
  routeOf: (moduleId: string) => string | undefined;
  /** Whether every page loads this module's stylesheets: `_app` and the client entry. */
  isAlwaysLoaded: (moduleId: string) => boolean;
  /** The chunk whose dynamic imports load the pages. */
  loaderChunk: string;
};

export type PagesPageStylesheets = {
  /** Each route's own stylesheets, in the order its page loads them. */
  routes: Record<string, string[]>;
  /**
   * Route stylesheets that other dynamic imports load too. Their
   * server-rendered links stay, as Next.js leaves the links of stylesheets in
   * its dynamic CSS manifest.
   */
  shared: string[];
  /** Route stylesheets for the page loaders to leave to the router. */
  unpreloaded: string[];
};

/**
 * Each Pages Router route's own stylesheets, the ones its client navigations
 * turn on and off. As in Next.js's client build manifest, they are the files a
 * page loads, in that order, without those every page loads with `_app`.
 */
export function collectPagesPageStylesheets(
  bundle: Readonly<Record<string, BundleItem>>,
  options: CollectPagesPageStylesheetsOptions,
): PagesPageStylesheets {
  const chunks = new Map<string, BundleItem>();
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk") chunks.set(item.fileName, item);
  }

  // A chunk's static imports evaluate first, so their stylesheets come first.
  const stylesheets = new Map<string, string[]>();
  const stylesheetsOf = (fileName: string): string[] => {
    let files = stylesheets.get(fileName);
    if (files) return files;

    const ordered = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const chunk = chunks.get(name);
      if (!chunk) return;
      for (const imported of chunk.imports ?? []) visit(imported);
      for (const file of chunk.viteMetadata?.importedCss ?? []) ordered.add(file);
    };
    visit(fileName);

    files = [...ordered];
    stylesheets.set(fileName, files);
    return files;
  };

  const routeOf = (chunk: BundleItem) =>
    chunk.facadeModuleId ? options.routeOf(chunk.facadeModuleId) : undefined;
  const isAlwaysLoaded = (chunk: BundleItem) =>
    !!chunk.facadeModuleId && options.isAlwaysLoaded(chunk.facadeModuleId);
  // The stylesheets of a dynamic import that isn't a page.
  const otherDynamicStylesheets = (chunk: BundleItem): string[] =>
    (chunk.dynamicImports ?? []).flatMap((fileName) => {
      const imported = chunks.get(fileName);
      if (!imported || routeOf(imported) !== undefined || isAlwaysLoaded(imported)) return [];
      return stylesheetsOf(fileName);
    });

  const alwaysLoaded = new Set<string>();
  const dynamic = new Set<string>();
  for (const chunk of chunks.values()) {
    if (isAlwaysLoaded(chunk)) {
      for (const file of stylesheetsOf(chunk.fileName)) alwaysLoaded.add(file);
    }
    for (const file of otherDynamicStylesheets(chunk)) dynamic.add(file);
  }

  const routes: Record<string, string[]> = {};
  const routed = new Set<string>();
  for (const chunk of chunks.values()) {
    const route = routeOf(chunk);
    if (route === undefined) continue;
    const files = stylesheetsOf(chunk.fileName).filter((file) => !alwaysLoaded.has(file));
    if (files.length === 0) continue;
    routes[route] = files;
    for (const file of files) routed.add(file);
  }

  // The loader chunk's other dynamic imports still load their stylesheets.
  const loader = chunks.get(options.loaderChunk);
  const loaderOwn = new Set(loader ? otherDynamicStylesheets(loader) : []);
  return {
    routes,
    shared: [...routed].filter((file) => dynamic.has(file)),
    unpreloaded: [...routed].filter((file) => !loaderOwn.has(file)),
  };
}

const PRELOAD_FILES =
  /^const __vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\n]*\])\)\)\)=>i\.map\(i=>d\[i\]\);$/m;
const PRELOAD_CALL = /__vite__mapDeps\(\[([\d,]*)\]\)/g;

/**
 * Removes `stylesheets` from what the chunk's dynamic imports preload. Vite
 * adds a dynamic import's stylesheets as `<link>`s when it loads, so a page
 * prefetch would apply that page's stylesheets to the current one. Next.js
 * only turns a page's stylesheets on when it renders.
 *
 * Each call keeps its length, so the chunk's source map still lines up.
 */
export function withoutPreloadedStylesheets(
  chunk: { code: string; fileName: string },
  stylesheets: ReadonlySet<string>,
): string {
  const match = PRELOAD_FILES.exec(chunk.code);
  if (!match) return chunk.code;
  let files: unknown;
  try {
    files = JSON.parse(match[1]);
  } catch {
    return chunk.code;
  }
  if (!Array.isArray(files)) return chunk.code;

  const isStylesheet = (url: unknown) => {
    if (typeof url !== "string") return false;
    const file = url.replace(/[?#].*$/, "");
    const resolved = file.startsWith(".")
      ? path.posix.join(path.posix.dirname(chunk.fileName), file)
      : file;
    for (const stylesheet of stylesheets) {
      if (resolved === stylesheet || resolved.endsWith(`/${stylesheet}`)) return true;
    }
    return false;
  };
  const removed = new Set<string>();
  files.forEach((url, index) => {
    if (isStylesheet(url)) removed.add(String(index));
  });
  if (removed.size === 0) return chunk.code;

  return chunk.code.replace(PRELOAD_CALL, (_call, list: string) => {
    const kept = list.split(",").filter((index) => !removed.has(index));
    return `__vite__mapDeps([${kept.join(",").padEnd(list.length)}])`;
  });
}

const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=[^\n]*\n?$/;

/**
 * Adds `code` on a line of its own at the end of a chunk, short of its source
 * map comment, which must stay last. The chunk's source map still lines up.
 */
export function appendToChunkCode(chunkCode: string, code: string): string {
  const comment = SOURCE_MAP_COMMENT.exec(chunkCode);
  if (!comment) return `${chunkCode}\n${code}`;
  return `${chunkCode.slice(0, comment.index)}\n${code}${comment[0]}`;
}
