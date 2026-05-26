import { normalizePath, parseAst, type Plugin } from "vite";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type NodeLike = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

type ImportMetaUrlEnvironment = "client" | "server";

type RewriteResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type RootPaths = {
  root: string;
  canonicalRoot: string;
  normalizedRoot: string;
};

export function createImportMetaUrlPlugin(options: { getRoot: () => string | undefined }): Plugin {
  let rootPaths: RootPaths | undefined;

  function getRootPaths(): RootPaths | undefined {
    const root = options.getRoot();
    if (!root) return rootPaths;
    if (!rootPaths || rootPaths.root !== root) {
      rootPaths = createRootPaths(root);
    }
    return rootPaths;
  }

  return {
    name: "vinext:import-meta-url",
    enforce: "post",
    configResolved(config) {
      rootPaths = createRootPaths(options.getRoot() ?? config.root);
    },
    transform(code, id) {
      if (!code.includes("import.meta.url")) return null;
      const paths = getRootPaths();
      if (!paths) return null;
      const cleanId = cleanModuleId(id);
      if (!isTransformableUserModule(cleanId, paths)) return null;

      const environment: ImportMetaUrlEnvironment =
        this.environment?.name === "client" ? "client" : "server";
      const rewritten = rewriteImportMetaUrlWithRootPaths(code, cleanId, paths, environment);
      if (!rewritten) return null;
      return {
        code: rewritten.code,
        map: rewritten.map,
      };
    },
  };
}

export function rewriteImportMetaUrl(
  code: string,
  id: string,
  root: string,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  if (!code.includes("import.meta.url")) return null;
  return rewriteImportMetaUrlWithRootPaths(code, id, createRootPaths(root), environment);
}

function rewriteImportMetaUrlWithRootPaths(
  code: string,
  id: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  if (!code.includes("import.meta.url")) return null;

  let ast: unknown;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const ranges = collectImportMetaUrlRanges(ast);
  if (ranges.length === 0) return null;

  const replacement = JSON.stringify(importMetaUrlValue(id, rootPaths, environment));
  const output = new MagicString(code);
  for (const range of ranges) {
    output.overwrite(range.start, range.end, replacement);
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0];
}

function createRootPaths(root: string): RootPaths {
  const canonicalRoot = canonicalizePath(root);
  return {
    root,
    canonicalRoot,
    normalizedRoot: normalizePath(canonicalRoot),
  };
}

function isTransformableUserModule(id: string, rootPaths: RootPaths): boolean {
  if (!id || id.startsWith("\0")) return false;
  if (!path.isAbsolute(id)) return false;
  if (id.includes("/node_modules/") || id.includes("\\node_modules\\")) return false;
  if (!/\.(tsx?|jsx?|mjs)$/.test(id)) return false;

  const canonicalId = canonicalizePath(id);
  const normalizedId = normalizePath(canonicalId);
  if (!isPathWithin(normalizedId, rootPaths.normalizedRoot)) return false;

  const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
  const firstSegment = relativePath.split("/")[0];
  return (
    firstSegment !== ".next" && firstSegment !== ".vinext-local-package" && firstSegment !== "dist"
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function importMetaUrlValue(
  id: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): string {
  const canonicalId = canonicalizePath(id);
  if (environment === "client") {
    const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
    return `file:///ROOT/${relativePath}`;
  }

  return pathToFileURL(canonicalId).href;
}

function canonicalizePath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function collectImportMetaUrlRanges(ast: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (!isNodeLike(value)) return;

    if (isImportMetaUrlNode(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isNewUrlExpression(value)) {
      const args = nodeArray(value.arguments);
      for (let index = 0; index < args.length; index += 1) {
        if (index === 1 && isImportMetaUrlNode(args[index])) continue;
        visit(args[index]);
      }
      visit(value.callee);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  }

  visit(ast);
  return ranges;
}

function isNodeLike(value: unknown): value is NodeLike {
  return !!value && typeof value === "object";
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isNodeLike(value) && value.type === "Identifier" && value.name === name;
}

function isImportMetaNode(value: unknown): boolean {
  return (
    isNodeLike(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

function isImportMetaUrlNode(value: unknown): value is NodeLike & { start: number; end: number } {
  return (
    isNodeLike(value) &&
    value.type === "MemberExpression" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

function isNewUrlExpression(value: NodeLike): boolean {
  return value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL");
}

function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
