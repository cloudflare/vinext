export type AstRecord = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

export type AstRange = AstRecord & {
  start: number;
  end: number;
};

/**
 * Cheap pre-parse gate for plugins that only transform *dynamic* `import(...)`.
 *
 * Static imports — `import x from "..."`, `import { ... } from "..."`,
 * `import "..."` — never place a `(` (nor a comment leading to one) immediately
 * after the `import` keyword. Plugins that act only on dynamic `import(...)` use
 * this to skip `parseAst` for the overwhelming majority of modules in a large
 * app: at ~5k routes, where almost every module is a static-import-only page,
 * it removes most of the build's AST-parse/GC cost. This is a deliberate,
 * measured performance filter — keep it a regex, never a parse.
 *
 * It intentionally errs toward over-matching: a false positive costs one
 * redundant parse, whereas a false negative would silently skip a real dynamic
 * import (a correctness bug). `\s*[(/]` therefore tolerates whitespace and
 * block/line comments between the `import` keyword and its parenthesis.
 *
 * Usable directly as a Rolldown `transform.filter.code` regex, or via
 * {@link mayContainDynamicImport} for an in-handler prescan.
 */
export const DYNAMIC_IMPORT_PRESCAN = /\bimport\s*[(/]/;

/**
 * Whether `code` might contain a dynamic `import(...)` call. See
 * {@link DYNAMIC_IMPORT_PRESCAN} — a cheap, deliberately over-inclusive regex
 * gate used to avoid parsing static-import-only modules.
 */
export function mayContainDynamicImport(code: string): boolean {
  return DYNAMIC_IMPORT_PRESCAN.test(code);
}

const SKIP_CHILD_KEYS = new Set(["type", "parent", "loc", "start", "end"]);

function getObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return null;
  return Reflect.get(value, key);
}

export function isAstRecord(value: unknown): value is AstRecord {
  return typeof getObjectProperty(value, "type") === "string";
}

function toAstRecord(value: unknown): AstRecord | null {
  return isAstRecord(value) ? value : null;
}

export function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function hasRange(node: AstRecord | null): node is AstRange {
  return node !== null && typeof node.start === "number" && typeof node.end === "number";
}

export function isIdentifierNamed(value: unknown, name: string): boolean {
  return isAstRecord(value) && value.type === "Identifier" && value.name === name;
}

export function getAstName(value: unknown): string | null {
  const node = toAstRecord(value);
  if (!node) return null;
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (typeof node.value === "string") return node.value;
  return null;
}

export function forEachAstChild(node: AstRecord, callback: (child: AstRecord) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_CHILD_KEYS.has(key)) continue;
    const child = toAstRecord(value);
    if (child) {
      callback(child);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemNode = toAstRecord(item);
        if (itemNode) callback(itemNode);
      }
    }
  }
}

export function collectBindingNames(pattern: unknown, target: Set<string>): void {
  const node = toAstRecord(pattern);
  if (!node) return;

  switch (node.type) {
    case "Identifier":
      if (typeof node.name === "string") target.add(node.name);
      return;
    case "RestElement":
      collectBindingNames(node.argument, target);
      return;
    case "AssignmentPattern":
      collectBindingNames(node.left, target);
      return;
    case "TSParameterProperty":
      collectBindingNames(node.parameter, target);
      return;
    case "ArrayPattern":
      for (const element of nodeArray(node.elements)) collectBindingNames(element, target);
      return;
    case "ObjectPattern":
      for (const property of nodeArray(node.properties)) {
        const propertyNode = toAstRecord(property);
        if (!propertyNode) continue;
        collectBindingNames(
          propertyNode.type === "Property" ? propertyNode.value : propertyNode.argument,
          target,
        );
      }
      return;
    case "Property":
      collectBindingNames(node.value, target);
      return;
  }
}
