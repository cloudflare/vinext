import type { Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";
import path from "node:path";

type AstRecord = {
  [key: string]: unknown;
};

type TransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type ResolveDynamicImport = (specifier: string, importer: string) => Promise<string | null>;

function isRecord(value: unknown): value is AstRecord {
  return !!value && typeof value === "object";
}

function getString(node: AstRecord, key: string): string | null {
  const value = node[key];
  return typeof value === "string" ? value : null;
}

function getNumber(node: AstRecord, key: string): number | null {
  const value = node[key];
  return typeof value === "number" ? value : null;
}

function getArray(node: AstRecord, key: string): unknown[] {
  const value = node[key];
  return Array.isArray(value) ? value : [];
}

function nodeName(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const name = node.name;
  if (typeof name === "string") return name;
  const value = node.value;
  return typeof value === "string" ? value : null;
}

function nodeStringValue(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const value = node.value;
  return typeof value === "string" ? value : null;
}

function walkAst(value: unknown, visitor: (node: AstRecord) => void): void {
  if (!isRecord(value)) return;
  visitor(value);

  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        walkAst(item, visitor);
      }
    } else if (isRecord(child)) {
      walkAst(child, visitor);
    }
  }
}

function importSource(node: AstRecord): string | null {
  const source = node.source;
  if (!isRecord(source)) return null;
  return nodeStringValue(source);
}

function isNextDynamicSource(source: string | null): boolean {
  return source === "next/dynamic" || source === "next/dynamic.js";
}

function collectDynamicImportLocals(ast: unknown): Set<string> {
  const locals = new Set<string>();
  if (!isRecord(ast)) return locals;

  for (const node of getArray(ast, "body")) {
    if (!isRecord(node)) continue;
    if (getString(node, "type") !== "ImportDeclaration") continue;
    if (!isNextDynamicSource(importSource(node))) continue;

    for (const specifier of getArray(node, "specifiers")) {
      if (!isRecord(specifier)) continue;
      if (getString(specifier, "type") !== "ImportDefaultSpecifier") continue;
      const local = nodeName(specifier.local);
      if (local) locals.add(local);
    }
  }

  return locals;
}

function isIdentifierNamed(node: unknown, names: Set<string>): boolean {
  if (!isRecord(node)) return false;
  return getString(node, "type") === "Identifier" && names.has(getString(node, "name") ?? "");
}

function isDynamicCall(node: AstRecord, dynamicLocals: Set<string>): boolean {
  if (getString(node, "type") !== "CallExpression") return false;
  return isIdentifierNamed(node.callee, dynamicLocals);
}

function collectImportSpecifiers(node: unknown): string[] {
  const specifiers: string[] = [];
  const seen = new Set<string>();

  walkAst(node, (item) => {
    if (getString(item, "type") === "ImportExpression") {
      const specifier = nodeStringValue(item.source);
      if (specifier && !seen.has(specifier)) {
        seen.add(specifier);
        specifiers.push(specifier);
      }
      return;
    }

    if (getString(item, "type") !== "CallExpression") return;
    const callee = item.callee;
    if (!isRecord(callee) || getString(callee, "type") !== "Import") return;
    const firstArg = getArray(item, "arguments")[0];
    const specifier = nodeStringValue(firstArg);
    if (specifier && !seen.has(specifier)) {
      seen.add(specifier);
      specifiers.push(specifier);
    }
  });

  return specifiers;
}

function propertyKeyName(property: unknown): string | null {
  if (!isRecord(property)) return null;
  return nodeName(property.key);
}

function objectProperties(node: unknown): AstRecord[] {
  if (!isRecord(node) || getString(node, "type") !== "ObjectExpression") return [];
  return getArray(node, "properties").filter(isRecord);
}

function hasObjectProperty(node: unknown, name: string): boolean {
  return objectProperties(node).some((property) => propertyKeyName(property) === name);
}

function findLastEndedProperty(node: AstRecord): AstRecord | null {
  const properties = objectProperties(node);
  for (let index = properties.length - 1; index >= 0; index -= 1) {
    if (getNumber(properties[index], "end") !== null) {
      return properties[index];
    }
  }
  return null;
}

function appendObjectProperty(
  output: MagicString,
  objectNode: AstRecord,
  property: string,
): boolean {
  const start = getNumber(objectNode, "start");
  const end = getNumber(objectNode, "end");
  if (start === null || end === null) return false;

  const lastProperty = findLastEndedProperty(objectNode);
  if (!lastProperty) {
    output.appendLeft(start + 1, property);
    return true;
  }

  const propertyEnd = getNumber(lastProperty, "end");
  if (propertyEnd === null) return false;
  output.appendLeft(propertyEnd, `, ${property}`);
  return true;
}

function insertSecondOptionsArgument(
  output: MagicString,
  code: string,
  callNode: AstRecord,
  firstArg: AstRecord,
  optionsLiteral: string,
): boolean {
  const callEnd = getNumber(callNode, "end");
  const firstArgEnd = getNumber(firstArg, "end");
  if (callEnd === null || firstArgEnd === null) return false;

  const closeParen = callEnd - 1;
  const betweenFirstArgAndClose = code.slice(firstArgEnd, closeParen);
  if (betweenFirstArgAndClose.includes(",")) {
    output.overwrite(firstArgEnd, closeParen, `, ${optionsLiteral}`);
  } else {
    output.appendLeft(closeParen, `, ${optionsLiteral}`);
  }
  return true;
}

function cleanResolvedId(id: string): string {
  let start = 0;
  while (start < id.length && id.charCodeAt(start) === 0) {
    start += 1;
  }

  return id
    .slice(start)
    .replace(/^\/@fs\//, "/")
    .split("?")[0]
    .replace(/\\/g, "/");
}

function toManifestModuleId(root: string, resolvedId: string): string | null {
  const cleaned = cleanResolvedId(resolvedId);
  if (!path.isAbsolute(cleaned)) return cleaned.replace(/^\/+/, "");

  const relative = path.relative(root, cleaned);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function resolveManifestModuleIds(
  specifiers: readonly string[],
  importer: string,
  root: string,
  resolveDynamicImport: ResolveDynamicImport,
): Promise<string[]> {
  const resolvedIds: string[] = [];
  const seen = new Set<string>();

  for (const specifier of specifiers) {
    const resolved = await resolveDynamicImport(specifier, importer);
    const moduleId = resolved ? toManifestModuleId(root, resolved) : null;
    if (!moduleId || seen.has(moduleId)) continue;
    seen.add(moduleId);
    resolvedIds.push(moduleId);
  }

  return resolvedIds;
}

function shouldSkipCall(firstArg: unknown, secondArg: unknown): boolean {
  if (hasObjectProperty(firstArg, "loadableGenerated")) return true;
  return hasObjectProperty(secondArg, "loadableGenerated");
}

function applyLoadableGenerated(
  output: MagicString,
  code: string,
  callNode: AstRecord,
  moduleIds: readonly string[],
): boolean {
  const args = getArray(callNode, "arguments");
  const firstArg = args[0];
  const secondArg = args[1];
  if (!isRecord(firstArg)) return false;
  if (shouldSkipCall(firstArg, secondArg)) return false;

  const property = `loadableGenerated: { modules: ${JSON.stringify(moduleIds)} }`;
  const firstArgIsObject = getString(firstArg, "type") === "ObjectExpression";
  if (firstArgIsObject) {
    return appendObjectProperty(output, firstArg, property);
  }

  if (secondArg === undefined) {
    return insertSecondOptionsArgument(output, code, callNode, firstArg, `{ ${property} }`);
  }

  if (isRecord(secondArg) && getString(secondArg, "type") === "ObjectExpression") {
    return appendObjectProperty(output, secondArg, property);
  }

  return false;
}

export async function transformNextDynamicPreloadMetadata(
  code: string,
  id: string,
  root: string,
  resolveDynamicImport: ResolveDynamicImport,
): Promise<TransformResult | null> {
  if (!code.includes("next/dynamic") || !code.includes("import(")) return null;

  let ast: unknown;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const dynamicLocals = collectDynamicImportLocals(ast);
  if (dynamicLocals.size === 0) return null;

  const output = new MagicString(code);
  let changed = false;
  const pending: Promise<void>[] = [];

  walkAst(ast, (node) => {
    if (!isDynamicCall(node, dynamicLocals)) return;
    const args = getArray(node, "arguments");
    const specifiers = collectImportSpecifiers(args[0]);
    if (specifiers.length === 0) return;

    pending.push(
      resolveManifestModuleIds(specifiers, id, root, resolveDynamicImport).then((moduleIds) => {
        if (moduleIds.length === 0) return;
        if (applyLoadableGenerated(output, code, node, moduleIds)) {
          changed = true;
        }
      }),
    );
  });

  await Promise.all(pending);

  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

export function createDynamicPreloadMetadataPlugin(): Plugin {
  let root = process.cwd();

  return {
    name: "vinext:dynamic-preload-metadata",
    configResolved(config) {
      root = config.root;
    },
    transform: {
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
          exclude: /node_modules/,
        },
        code: "next/dynamic",
      },
      async handler(code, id) {
        if (id.includes("node_modules") || id.startsWith("\0")) return null;
        if (!/\.(tsx?|jsx?|mjs)$/.test(id)) return null;

        const result = await transformNextDynamicPreloadMetadata(
          code,
          id,
          root,
          async (specifier) => {
            const resolved = await this.resolve(specifier, id, { skipSelf: true });
            return resolved?.id ?? null;
          },
        );
        if (!result) return null;
        return result;
      },
    },
  };
}
