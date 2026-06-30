import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createIdResolver, parseSync, type ESTree, type Plugin } from "vite";
import { fnv1a64 } from "../utils/hash.js";

const STYLESHEET_RE = /\.(?:css|less|sass|scss|styl|stylus)$/i;
const CSS_MODULE_RE = /\.module\.(?:css|less|sass|scss|styl|stylus)$/i;
const EMPTY_LAYOUT_CSS_PREFIX = "\0vinext:layout-owned-global-css/";
const SOURCE_MODULE_RE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT = 10_000;
const MAX_PAGES_GRAPH_MODULES = 10_000;
const NON_STYLESHEET_QUERY_RE = /[?&](?:inline|raw|url)\b/;

type LayoutOwnedGlobalCssOptions = {
  getPageExtensions?: () => string[];
  getMdxOptions?: () => {
    remarkPlugins?: unknown[];
    rehypePlugins?: unknown[];
    recmaPlugins?: unknown[];
  } | null;
  maxPagesGraphModules?: number;
};

type ResolveContext = {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ): Promise<{ id: string } | null>;
};

function cleanModuleId(id: string): string {
  const suffixIndex = id.search(/[?#]/);
  return suffixIndex === -1 ? id : id.slice(0, suffixIndex);
}

function graphModuleId(id: string): string {
  return STYLESHEET_RE.test(cleanModuleId(id)) ? id : cleanModuleId(id);
}

function hasNonStylesheetQuery(id: string): boolean {
  return NON_STYLESHEET_QUERY_RE.test(id);
}

function isNonStylesheetImport(source: string, resolvedId: string): boolean {
  return hasNonStylesheetQuery(source) || hasNonStylesheetQuery(resolvedId);
}

function isDescendantPath(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sourceModuleLang(modulePath: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.(?:mts|cts|ts)$/i.test(modulePath)) return "ts";
  if (/\.tsx$/i.test(modulePath)) return "tsx";
  if (/\.jsx$/i.test(modulePath)) return "jsx";
  return "js";
}

function extractModuleSources(
  modulePath: string,
  source: string,
): Array<{ source: string; isDynamic: boolean }> {
  const result = parseSync(modulePath, source, {
    astType: "ts",
    lang: sourceModuleLang(modulePath),
    sourceType: "module",
  });
  const parseError = result.errors.find((error) => error.severity === "Error");
  if (parseError) {
    throw new Error(
      `Unable to scan layout-owned CSS imports in ${modulePath}: ${parseError.message}`,
    );
  }

  const sources = new Map<string, boolean>();

  function visit(node: ESTree.Node | ESTree.Node[] | null | undefined): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source && typeof node.source.value === "string") {
        sources.set(node.source.value, false);
      }
    } else if (
      node.type === "ImportExpression" &&
      node.source.type === "Literal" &&
      typeof node.source.value === "string"
    ) {
      if (!sources.has(node.source.value)) sources.set(node.source.value, true);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "parent") {
        continue;
      }
      if (value && typeof value === "object") {
        visit(value as ESTree.Node | ESTree.Node[]);
      }
    }
  }

  visit(result.program);
  return [...sources].map(([source, isDynamic]) => ({ source, isDynamic }));
}

function maskMdxHtmlComments(source: string): string {
  const maskedLines: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inHtmlComment = false;

  for (const line of source.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (
        marker === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      maskedLines.push(line);
      continue;
    }

    if (fence || /^ {4}/.test(line)) {
      maskedLines.push(line);
      continue;
    }

    let maskedLine = "";
    let offset = 0;
    while (offset < line.length) {
      if (inHtmlComment) {
        const commentEnd = line.indexOf("-->", offset);
        if (commentEnd === -1) {
          maskedLine += " ".repeat(line.length - offset);
          offset = line.length;
        } else {
          maskedLine += " ".repeat(commentEnd + 3 - offset);
          offset = commentEnd + 3;
          inHtmlComment = false;
        }
        continue;
      }

      const commentStart = line.indexOf("<!--", offset);
      if (commentStart === -1 || line.slice(0, commentStart).trim() !== "") {
        maskedLine += line.slice(offset);
        break;
      }
      maskedLine += line.slice(offset, commentStart) + " ".repeat(4);
      offset = commentStart + 4;
      inHtmlComment = true;
    }
    maskedLines.push(maskedLine);
  }

  return maskedLines.join("\n");
}

async function extractMdxModuleSources(
  modulePath: string,
  source: string,
  options: LayoutOwnedGlobalCssOptions,
): Promise<Array<{ source: string; isDynamic: boolean }>> {
  const mdxRollup = await import("@mdx-js/rollup");
  const mdxFactory = mdxRollup.default as (options: Record<string, unknown>) => Plugin;
  const mdxOptions = options.getMdxOptions?.();
  const extension = path.extname(modulePath).toLowerCase();
  const transformPlugin = mdxFactory({
    ...mdxOptions,
    include: modulePath,
    ...(extension === ".md" || extension === ".mdx" ? {} : { mdxExtensions: [extension] }),
    jsx: true,
    outputFormat: "program",
  });
  const transformHook = transformPlugin.transform;
  if (!transformHook) return [];
  const transform = typeof transformHook === "function" ? transformHook : transformHook.handler;
  const result = await transform.call(
    {} as never,
    maskMdxHtmlComments(source),
    modulePath,
    {} as never,
  );
  if (!result) return [];

  const compiledSource = typeof result === "string" ? result : String(result.code ?? "");
  return extractModuleSources(`${modulePath}.jsx`, compiledSource);
}

export function createLayoutOwnedGlobalCssPlugin(
  getAppDir: () => string,
  getPagesDir: () => string | null = () => null,
  options: LayoutOwnedGlobalCssOptions = {},
): Plugin {
  // plugin-rsc builds RSC and server environments before the client environment.
  // Client deduplication depends on those earlier builds populating the ownership graph.
  const ownerDirectories = new Map<string, Set<string>>();
  const moduleOwners = new Map<string, Set<string>>();
  const moduleImports = new Map<string, Set<string>>();
  const moduleImporters = new Map<string, Set<string>>();
  const globalStylesheets = new Set<string>();
  const pagesConsumers = new Set<string>();
  const pagesImports = new Map<string, Set<string>>();
  let pagesConsumerScan: Promise<void> | null = null;
  let pagesConsumerScanState: "idle" | "scanning" | "complete" = "idle";
  let pagesScanIsConservative = false;

  function isPagesServerEnvironment(environment: { name: string } | undefined): boolean {
    return environment !== undefined && environment.name !== "client" && environment.name !== "rsc";
  }

  function normalizedPageExtensions(): string[] {
    return (options.getPageExtensions?.() ?? ["tsx", "ts", "jsx", "js", "mts", "cts", "mjs", "cjs"])
      .map((extension) => extension.replace(/^\./, "").toLowerCase())
      .filter(Boolean);
  }

  function isAppSharedOwner(modulePath: string): boolean {
    const fileName = path.basename(cleanModuleId(modulePath)).toLowerCase();
    return normalizedPageExtensions().some(
      (extension) => fileName === `layout.${extension}` || fileName === `template.${extension}`,
    );
  }

  function isPagesApiRoute(modulePath: string, pagesDir: string): boolean {
    const relativePath = path.relative(pagesDir, modulePath);
    if (relativePath.startsWith(`api${path.sep}`)) return true;

    const lowerRelativePath = relativePath.toLowerCase();
    return normalizedPageExtensions().some((extension) => lowerRelativePath === `api.${extension}`);
  }

  function addOwners(moduleId: string, owners: Iterable<string>): void {
    moduleId = graphModuleId(moduleId);
    let moduleOwnerDirectories = moduleOwners.get(moduleId);
    if (!moduleOwnerDirectories) {
      moduleOwnerDirectories = new Set();
      moduleOwners.set(moduleId, moduleOwnerDirectories);
    }
    const addedOwners: string[] = [];
    for (const owner of owners) {
      if (moduleOwnerDirectories.has(owner)) continue;
      moduleOwnerDirectories.add(owner);
      addedOwners.push(owner);
    }
    if (addedOwners.length === 0) return;

    if (globalStylesheets.has(moduleId)) {
      let stylesheetOwners = ownerDirectories.get(moduleId);
      if (!stylesheetOwners) {
        stylesheetOwners = new Set();
        ownerDirectories.set(moduleId, stylesheetOwners);
      }
      for (const owner of addedOwners) stylesheetOwners.add(owner);
    }

    for (const importedId of moduleImports.get(moduleId) ?? []) {
      addOwners(importedId, addedOwners);
    }
  }

  function addImport(importer: string, importedId: string, propagateOwners = true): void {
    importer = graphModuleId(importer);
    importedId = graphModuleId(importedId);
    let imports = moduleImports.get(importer);
    if (!imports) {
      imports = new Set();
      moduleImports.set(importer, imports);
    }
    if (propagateOwners) imports.add(importedId);

    let importers = moduleImporters.get(importedId);
    if (!importers) {
      importers = new Set();
      moduleImporters.set(importedId, importers);
    }
    importers.add(importer);
  }

  function markPagesConsumer(moduleId: string): void {
    moduleId = graphModuleId(moduleId);
    if (pagesConsumers.has(moduleId)) return;
    pagesConsumers.add(moduleId);
    for (const importedId of pagesImports.get(moduleId) ?? []) {
      markPagesConsumer(importedId);
    }
  }

  function addPagesImport(importer: string, importedId: string): void {
    importer = graphModuleId(importer);
    importedId = graphModuleId(importedId);
    let imports = pagesImports.get(importer);
    if (!imports) {
      imports = new Set();
      pagesImports.set(importer, imports);
    }
    imports.add(importedId);
    addImport(importer, importedId, false);
    if (pagesConsumers.has(importer)) markPagesConsumer(importedId);
  }

  function allConsumersInheritOwner(moduleId: string, owner: string, appDir: string): boolean {
    const visited = new Set<string>();

    function visit(currentId: string): boolean {
      currentId = graphModuleId(currentId);
      if (visited.has(currentId)) return true;
      visited.add(currentId);

      if (pagesConsumers.has(currentId)) return false;
      if (pagesScanIsConservative) return false;

      const currentPath = path.resolve(cleanModuleId(currentId));
      if (isAppSharedOwner(currentPath) && path.dirname(currentPath) === owner) return true;

      const importers = moduleImporters.get(currentId);
      if (importers && importers.size > 0) {
        return [...importers].every(visit);
      }

      if (moduleOwners.get(currentId)?.has(owner) === true) return true;
      if (!isDescendantPath(currentPath, appDir)) return false;
      return isDescendantPath(currentPath, owner);
    }

    return visit(moduleId);
  }

  async function resolveExternalImport(
    context: ResolveContext,
    source: string,
    importer: string,
  ): Promise<string | null> {
    const resolved = await context.resolve(source, cleanModuleId(importer), { skipSelf: true });
    if (resolved && !resolved.id.startsWith("\0") && path.isAbsolute(cleanModuleId(resolved.id))) {
      return resolved.id;
    }

    if (source.startsWith(".")) {
      const relativePath = path.resolve(
        path.dirname(cleanModuleId(importer)),
        cleanModuleId(source),
      );
      try {
        if ((await fs.stat(relativePath)).isFile()) return relativePath;
      } catch {}
    }

    try {
      return createRequire(cleanModuleId(importer)).resolve(source);
    } catch {
      return null;
    }
  }

  async function resolvePagesImport(
    context: ResolveContext,
    source: string,
    importer: string,
  ): Promise<string | null> {
    return resolveExternalImport(context, source, importer);
  }

  async function scanExternalModule(context: ResolveContext, rootModuleId: string): Promise<void> {
    const rootPath = cleanModuleId(rootModuleId);
    if (!SOURCE_MODULE_RE.test(rootPath)) return;

    const visited = new Set<string>();
    const pending = [rootModuleId];
    const edges: Array<{
      importer: string;
      imported: string;
      globalStylesheet: boolean;
      isDynamic: boolean;
    }> = [];

    while (pending.length > 0) {
      const moduleId = pending.pop()!;
      const modulePath = cleanModuleId(moduleId);
      if (visited.has(modulePath) || !SOURCE_MODULE_RE.test(modulePath)) continue;
      visited.add(modulePath);
      if (visited.size > MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT) {
        throw new Error(
          `Layout-owned CSS dependency graph from ${rootPath} exceeds ${MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT.toLocaleString()} modules`,
        );
      }

      let source: string;
      try {
        source = await fs.readFile(modulePath, "utf8");
      } catch {
        continue;
      }

      for (const { source: importSource, isDynamic } of extractModuleSources(modulePath, source)) {
        const importedPath = await resolveExternalImport(context, importSource, modulePath);
        if (!importedPath) continue;
        const globalStylesheet =
          STYLESHEET_RE.test(cleanModuleId(importedPath)) &&
          !CSS_MODULE_RE.test(cleanModuleId(importedPath)) &&
          !isNonStylesheetImport(importSource, importedPath);
        edges.push({
          importer: moduleId,
          imported: importedPath,
          globalStylesheet: globalStylesheet && !isDynamic,
          isDynamic,
        });
        if (!globalStylesheet && !isDynamic) pending.push(importedPath);
      }
    }

    for (const edge of edges) {
      addImport(edge.importer, edge.imported, !edge.isDynamic);
      if (edge.globalStylesheet) globalStylesheets.add(edge.imported);
      if (!edge.isDynamic) {
        addOwners(edge.imported, moduleOwners.get(graphModuleId(edge.importer)) ?? []);
      }
    }
  }

  async function scanPagesConsumers(context: ResolveContext): Promise<void> {
    const pagesDir = getPagesDir();
    if (!pagesDir) return;
    if (pagesConsumerScanState === "complete") return;
    if (pagesConsumerScan) return pagesConsumerScan;
    pagesConsumerScanState = "scanning";

    pagesConsumerScan = (async () => {
      const configuredPageExtensions = normalizedPageExtensions();
      const configuredPageExtension = (modulePath: string) => {
        const lowerPath = modulePath.toLowerCase();
        return configuredPageExtensions.find((extension) => lowerPath.endsWith(`.${extension}`));
      };
      const maxModules = options.maxPagesGraphModules ?? MAX_PAGES_GRAPH_MODULES;
      const isScannableModule = (modulePath: string) =>
        SOURCE_MODULE_RE.test(modulePath) || configuredPageExtension(modulePath) !== undefined;
      const pending: string[] = [];
      const directoryEntries = await fs.readdir(pagesDir, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of directoryEntries) {
        if (!entry.isFile() || configuredPageExtension(entry.name) === undefined) continue;
        const modulePath = path.join(entry.parentPath, entry.name);
        if (isPagesApiRoute(modulePath, pagesDir)) continue;
        markPagesConsumer(modulePath);
        pending.push(modulePath);
      }

      const visited = new Set<string>();
      while (pending.length > 0) {
        const modulePath = pending.pop()!;
        const cleanPath = cleanModuleId(modulePath);
        if (visited.has(cleanPath)) continue;
        visited.add(cleanPath);
        if (visited.size > maxModules) {
          pagesScanIsConservative = true;
          return;
        }

        let source: string;
        try {
          source = await fs.readFile(cleanPath, "utf8");
        } catch {
          pagesScanIsConservative = true;
          return;
        }

        let imports: Array<{ source: string; isDynamic: boolean }>;
        try {
          imports = SOURCE_MODULE_RE.test(cleanPath)
            ? extractModuleSources(cleanPath, source)
            : configuredPageExtension(cleanPath) !== undefined
              ? await extractMdxModuleSources(cleanPath, source, options)
              : [];
        } catch {
          pagesScanIsConservative = true;
          return;
        }

        for (const { source: importSource } of imports) {
          const resolved = await resolvePagesImport(context, importSource, cleanPath);
          if (!resolved) {
            pagesScanIsConservative = true;
            return;
          }
          addPagesImport(cleanPath, resolved);
          if (isScannableModule(cleanModuleId(resolved))) pending.push(resolved);
        }
      }
    })();

    try {
      await pagesConsumerScan;
      pagesConsumerScanState = "complete";
    } finally {
      pagesConsumerScan = null;
      if (pagesConsumerScanState === "scanning") pagesConsumerScanState = "idle";
    }
  }

  return {
    name: "vinext:layout-owned-global-css",
    enforce: "pre",
    apply: "build",

    async buildStart() {
      if (isPagesServerEnvironment(this.environment)) {
        const environment = this.environment;
        if (environment.config) {
          const resolveId = createIdResolver(environment.config);
          await scanPagesConsumers({
            async resolve(source, importer) {
              const id = await resolveId(environment, source, importer);
              return id ? { id } : null;
            },
          });
        } else {
          await scanPagesConsumers(this);
        }
      } else if (
        this.environment?.name === "client" &&
        getPagesDir() !== null &&
        pagesConsumerScanState !== "complete"
      ) {
        pagesScanIsConservative = true;
      }
    },

    async resolveDynamicImport(source, importer) {
      if (typeof source !== "string" || !importer) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.id.startsWith("\0")) return null;
      if (this.environment?.name === "rsc") {
        addImport(importer, resolved.id, false);
        return null;
      } else if (isPagesServerEnvironment(this.environment)) {
        const pagesDir = getPagesDir();
        if (!pagesDir) return resolved;
        const normalizedPagesDir = path.resolve(pagesDir);
        const importerId = graphModuleId(importer);
        if (isDescendantPath(path.resolve(cleanModuleId(importer)), normalizedPagesDir)) {
          markPagesConsumer(importer);
        }
        if (pagesConsumers.has(importerId)) addPagesImport(importer, resolved.id);
        return resolved;
      }
      return null;
    },

    async resolveId(source, importer) {
      if (!importer || source.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return null;

      const importerPath = path.resolve(cleanModuleId(importer));
      const normalizedAppDir = path.resolve(getAppDir());
      const pagesDir = getPagesDir();
      const normalizedPagesDir = pagesDir ? path.resolve(pagesDir) : null;

      if (isPagesServerEnvironment(this.environment) && normalizedPagesDir) {
        const importerId = graphModuleId(importer);
        const isPagesRoute = isDescendantPath(importerPath, normalizedPagesDir);
        if (!isPagesRoute && !pagesConsumers.has(importerId)) return null;
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.id.startsWith("\0")) return null;
        if (isPagesRoute) markPagesConsumer(importer);
        addPagesImport(importer, resolved.id);
        return null;
      }

      if (this.environment?.name === "rsc") {
        if (isDescendantPath(importerPath, normalizedAppDir) && isAppSharedOwner(importerPath)) {
          addOwners(importer, [path.dirname(importerPath)]);
        }

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.id.startsWith("\0")) return null;

        const resolvedPath = cleanModuleId(resolved.id);
        if (!path.isAbsolute(resolvedPath)) return null;
        const isGlobalStylesheet =
          STYLESHEET_RE.test(resolvedPath) && !CSS_MODULE_RE.test(resolvedPath);
        addImport(importer, resolved.id);

        const isStylesheetImport =
          isGlobalStylesheet && !isNonStylesheetImport(source, resolved.id);
        if (isStylesheetImport) {
          globalStylesheets.add(resolved.id);
        }
        addOwners(resolved.id, moduleOwners.get(graphModuleId(importer)) ?? []);
        if (resolved.external) {
          try {
            await scanExternalModule(this, resolved.id);
          } catch {
            pagesScanIsConservative = true;
          }
        }

        return isStylesheetImport ? resolved : null;
      }

      if (this.environment?.name !== "client") return null;
      if (pagesConsumerScanState === "scanning") return null;

      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;
      if (isNonStylesheetImport(source, resolved.id)) return null;
      const resolvedPath = cleanModuleId(resolved.id);
      const isGlobalStylesheet =
        STYLESHEET_RE.test(resolvedPath) && !CSS_MODULE_RE.test(resolvedPath);
      if (!isGlobalStylesheet) return null;

      const owners = ownerDirectories.get(resolved.id);
      const importerOwners = moduleOwners.get(graphModuleId(importer));
      const isOwnedImport =
        owners &&
        [...owners].some(
          (owner) =>
            (isDescendantPath(importerPath, owner) || importerOwners?.has(owner) === true) &&
            allConsumersInheritOwner(importer, owner, normalizedAppDir),
        );
      if (!isOwnedImport) {
        return null;
      }

      return `${EMPTY_LAYOUT_CSS_PREFIX}${fnv1a64(resolved.id)}.css`;
    },

    load(id) {
      if (id.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return "";
      return null;
    },
  };
}
