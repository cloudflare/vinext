import path from "pathslash";
import type { ESTree, RenderBuiltAssetUrl } from "vite";
import { parseProgram } from "../plugins/ast-utils.js";
import { appendDeploymentIdQuery } from "../utils/deployment-id.js";
import { assetServingUrlFromBaseAnchored, manifestFileWithBase } from "../utils/manifest-paths.js";

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
  /** Each route's page chunk, whose loader leaves its stylesheets to the router. */
  routeChunks: Record<string, string>;
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
  // The stylesheets of a dynamic import other than the loader chunk's pages.
  const otherDynamicStylesheets = (chunk: BundleItem): string[] =>
    (chunk.dynamicImports ?? []).flatMap((fileName) => {
      const imported = chunks.get(fileName);
      if (!imported || isAlwaysLoaded(imported)) return [];
      if (chunk.fileName === options.loaderChunk && routeOf(imported) !== undefined) return [];
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
  const routeChunks: Record<string, string> = {};
  for (const chunk of chunks.values()) {
    const route = routeOf(chunk);
    if (route === undefined) continue;
    routeChunks[route] = chunk.fileName;
    const files = stylesheetsOf(chunk.fileName).filter((file) => !alwaysLoaded.has(file));
    if (files.length === 0) continue;
    routes[route] = files;
    for (const file of files) routed.add(file);
  }

  return { routes, shared: [...routed].filter((file) => dynamic.has(file)), routeChunks };
}

// The table of files that Vite's dynamic imports preload, which Vite adds at
// the start of the chunk.
const PRELOAD_FILES_START = "const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=";

/**
 * Removes `stylesheets` from what the client entry's page loaders
 * preload. Vite adds a dynamic import's stylesheets as `<link>`s when it
 * loads, so a page prefetch would apply that page's stylesheets to the
 * current one. Next.js only turns a page's stylesheets on when it renders.
 * The chunk's other dynamic imports still preload theirs.
 *
 * Each call keeps its length, so the chunk's source map still lines up.
 */
export function withoutPreloadedStylesheets(
  chunk: { code: string; fileName: string },
  options: {
    stylesheets: ReadonlySet<string>;
    routeChunks: Readonly<Record<string, string>>;
    renderBuiltUrl?: RenderBuiltAssetUrl;
  },
): string {
  const { stylesheets, renderBuiltUrl } = options;
  if (!chunk.code.includes(PRELOAD_FILES_START)) return chunk.code;
  const program = parseOrUndefined(chunk.code);
  const files = program && preloadTable(program, chunk.code);
  if (!program || !files) return chunk.code;

  // The URLs that `renderBuiltUrl` renders, which Vite adds to the table as
  // they are: strings, or runtime expressions.
  const renderedUrls = new Set<string>();
  const runtimeUrls = new Set<string>();
  for (const stylesheet of stylesheets) {
    const result = renderBuiltUrl?.(stylesheet, {
      type: "asset",
      hostId: chunk.fileName,
      hostType: "js",
      ssr: false,
    });
    if (typeof result === "string") renderedUrls.add(result);
    if (typeof result !== "object" || !result?.runtime) continue;
    const code = `${PRELOAD_FILES_START}[${result.runtime}])))=>i;`;
    const parsed = parseOrUndefined(code);
    const expression = parsed && preloadTable(parsed, code);
    if (expression?.length === 1) runtimeUrls.add(expression[0].source);
  }

  const isStylesheet = (element: { source: string; value: unknown }) => {
    if (runtimeUrls.has(element.source)) return true;
    if (typeof element.value !== "string") return false;
    if (renderedUrls.has(element.value)) return true;
    const file = element.value.replace(/[?#].*$/, "");
    const resolved = file.startsWith(".")
      ? path.posix.join(path.posix.dirname(chunk.fileName), file)
      : file;
    for (const stylesheet of stylesheets) {
      if (resolved === stylesheet || resolved.endsWith(`/${stylesheet}`)) return true;
    }
    return false;
  };
  const removed = new Set<number>();
  files.forEach((element, index) => {
    if (isStylesheet(element)) removed.add(index);
  });
  if (removed.size === 0) return chunk.code;

  // The client entry assigns its page loaders to window in place:
  // `window.__VINEXT_PAGE_LOADERS__ = { "/route": () => import("./page.js") }`,
  // which Vite turns into `"/route": () => preload(() => import("./page.js"),
  // __vite__mapDeps([...]))`. Other imports of a page, such as one from
  // instrumentation-client, aren't followed by the router's stylesheet load.
  const lists: ESTree.ArrayExpression[] = [];
  walkExpression(program, (node) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.left.type !== "MemberExpression" ||
      node.left.object.type !== "Identifier" ||
      node.left.object.name !== "window" ||
      node.left.property.type !== "Identifier" ||
      node.left.property.name !== "__VINEXT_PAGE_LOADERS__" ||
      node.right.type !== "ObjectExpression"
    ) {
      return;
    }
    for (const property of node.right.properties) {
      const list =
        property.type === "Property" &&
        pageLoaderPreloads(property, chunk.fileName, options.routeChunks);
      if (list) lists.push(list);
    }
  });

  let code = chunk.code;
  for (const list of lists.sort((a, b) => b.start - a.start)) {
    const indexes = list.elements.map((element) =>
      element?.type === "Literal" && typeof element.value === "number" ? element.value : undefined,
    );
    if (indexes.includes(undefined)) continue;
    const kept = indexes.filter((index) => !removed.has(index!)).join(",");
    code = `${code.slice(0, list.start)}[${kept.padEnd(list.end - list.start - 2)}]${code.slice(list.end)}`;
  }
  return code;
}

/** The preload list of a page loader, `"/route": () => preload(() => import(...), ...)`. */
function pageLoaderPreloads(
  property: ESTree.ObjectProperty,
  chunkFileName: string,
  routeChunks: Readonly<Record<string, string>>,
): ESTree.ArrayExpression | undefined {
  if (
    property.key.type !== "Literal" ||
    typeof property.key.value !== "string" ||
    !Object.hasOwn(routeChunks, property.key.value) ||
    property.value.type !== "ArrowFunctionExpression" ||
    property.value.body.type !== "CallExpression"
  ) {
    return undefined;
  }
  const [loader, deps] = property.value.body.arguments;
  if (
    loader?.type !== "ArrowFunctionExpression" ||
    loader.body.type !== "ImportExpression" ||
    deps?.type !== "CallExpression" ||
    deps.callee.type !== "Identifier" ||
    deps.callee.name !== "__vite__mapDeps" ||
    deps.arguments[0]?.type !== "ArrayExpression"
  ) {
    return undefined;
  }
  const specifier = stringValue(loader.body.source);
  if (specifier === undefined) return undefined;
  const imported = path.posix.join(path.posix.dirname(chunkFileName), specifier);
  return imported === routeChunks[property.key.value] ? deps.arguments[0] : undefined;
}

/** The value of a string literal, or of a template literal without expressions. */
function stringValue(node: ESTree.Expression): string | undefined {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function parseOrUndefined(code: string): ESTree.Program | undefined {
  try {
    return parseProgram(code);
  } catch {
    return undefined;
  }
}

/**
 * The elements of the table that `__vite__mapDeps` reads, from the chunk's
 * parsed code: their source, and their value when they are strings. Vite adds
 * the runtime expressions that `renderBuiltUrl` returns as they are.
 */
function preloadTable(
  program: ESTree.Program,
  code: string,
): { source: string; value: unknown }[] | undefined {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    const declaration = statement.declarations[0];
    if (declaration?.id.type !== "Identifier" || declaration.id.name !== "__vite__mapDeps") {
      continue;
    }
    let table: ESTree.ArrayExpression | undefined;
    walkExpression(declaration.init, (node) => {
      if (
        !table &&
        node.type === "AssignmentExpression" &&
        node.left.type === "MemberExpression" &&
        node.left.property.type === "Identifier" &&
        node.left.property.name === "f" &&
        node.right.type === "ArrayExpression"
      ) {
        table = node.right;
      }
    });
    if (!table) return undefined;
    const elements: { source: string; value: unknown }[] = [];
    for (const element of (table as ESTree.ArrayExpression).elements) {
      if (!element || element.type === "SpreadElement") return undefined;
      elements.push({
        source: code.slice(element.start, element.end),
        value: element.type === "Literal" ? element.value : undefined,
      });
    }
    return elements;
  }
  return undefined;
}

/** Visits `node` and the nodes within it, outer ones first. */
function walkExpression(node: unknown, visit: (node: ESTree.Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkExpression(item, visit);
    return;
  }
  const value = node as ESTree.Node;
  if (typeof value.type !== "string") return;
  visit(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walkExpression(child, visit);
  }
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

/**
 * The URL that the server links `file` with: under `basePath`, or under
 * `assetPrefix` in its place, with the deployment ID query that Next.js adds to
 * stylesheets. Client navigations tell a page's server links by it.
 */
export function pagesStylesheetUrl(
  file: string,
  options: { base: string; basePath: string; assetPrefix: string; deploymentId?: string },
): string {
  return appendDeploymentIdQuery(
    assetServingUrlFromBaseAnchored(
      manifestFileWithBase(file, options.base),
      options.basePath,
      options.assetPrefix,
    ),
    options.deploymentId,
  );
}
