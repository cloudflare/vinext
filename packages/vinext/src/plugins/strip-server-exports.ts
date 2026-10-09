import { parseAst } from "vite";
import MagicString from "magic-string";
import { getAstName } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

type ParsedAst = ReturnType<typeof parseAst>;
type ASTNode = ParsedAst["body"][number]["parent"];
// Vite's AST type is a large discriminated union whose node-specific fields
// are not exposed after generic traversal. Runtime checks below narrow each
// use; the index signature keeps those ESTree fields addressable.
// oxlint-disable-next-line typescript/no-explicit-any
type PositionedNode = ASTNode & { start: number; end: number; [key: string]: any };

const SERVER_EXPORTS = new Set([
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  // Next.js's Babel transform still strips these legacy names so importing an
  // old page does not pull its server implementation into the browser graph.
  "unstable_getServerProps",
  "unstable_getServerSideProps",
  "unstable_getStaticProps",
  "unstable_getStaticPaths",
]);

const SERVER_PROPS_SSG_CONFLICT =
  "You can not use getStaticProps or getStaticPaths with getServerSideProps. To use SSG, please remove getServerSideProps";
const EXPORT_ALL_IN_PAGE_ERROR =
  "Using `export * from '...'` in a page is disallowed. Please use `export { default } from '...'` instead.\nRead more: https://nextjs.org/docs/messages/export-all-in-page";

export function hasServerExportCandidate(code: string): boolean {
  for (const name of SERVER_EXPORTS) {
    if (code.includes(name)) return true;
  }
  return false;
}

/** Transform prefilter; must admit every module `hasExportAllCandidate` accepts */
export const EXPORT_ALL_CANDIDATE_FILTER = /\bexport\s*[*/]/;

export function hasExportAllCandidate(code: string): boolean {
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const exportStart = code.indexOf("export", searchFrom);
    if (exportStart === -1) return false;
    searchFrom = exportStart + "export".length;
    const previous = code.charCodeAt(exportStart - 1);
    const next = code.charCodeAt(searchFrom);
    if (
      (previous >= 48 && previous <= 57) ||
      (previous >= 65 && previous <= 90) ||
      previous === 95 ||
      (previous >= 97 && previous <= 122) ||
      (next >= 48 && next <= 57) ||
      (next >= 65 && next <= 90) ||
      next === 95 ||
      (next >= 97 && next <= 122)
    ) {
      continue;
    }

    let position = searchFrom;
    while (position < code.length) {
      const char = code[position];
      if (/\s/.test(char)) {
        position++;
        continue;
      }
      if (char === "/" && code[position + 1] === "*") {
        const commentEnd = code.indexOf("*/", position + 2);
        if (commentEnd === -1) break;
        position = commentEnd + 2;
        continue;
      }
      if (char === "/" && code[position + 1] === "/") {
        const lineEnd = code.indexOf("\n", position + 2);
        position = lineEnd === -1 ? code.length : lineEnd + 1;
        continue;
      }
      if (char === "*") return true;
      break;
    }
  }
  return false;
}

type Binding = {
  name: string;
  node: PositionedNode;
  parent: PositionedNode;
  kind: "function" | "class" | "variable" | "import";
  implementation: PositionedNode;
  declaredNames: string[];
};

// Replacements that copy kept source are rendered lazily, once every nested
// edit inside the copied range is known.
type Edit = { start: number; end: number; replacement: string | (() => string) };

function isInsideRanges(position: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

function bindingNames(pattern: PositionedNode | null | undefined): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument as PositionedNode);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left as PositionedNode);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element: PositionedNode | null) => bindingNames(element));
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property: PositionedNode) => {
      if (property.type === "RestElement") return bindingNames(property.argument as PositionedNode);
      return bindingNames(property.value as PositionedNode);
    });
  }
  return [];
}

function bindingIdentifiers(pattern: PositionedNode | null | undefined): PositionedNode[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "RestElement") return bindingIdentifiers(pattern.argument as PositionedNode);
  if (pattern.type === "AssignmentPattern") {
    return bindingIdentifiers(pattern.left as PositionedNode);
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element: PositionedNode | null) =>
      bindingIdentifiers(element),
    );
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property: PositionedNode) => {
      if (property.type === "RestElement") {
        return bindingIdentifiers(property.argument as PositionedNode);
      }
      return bindingIdentifiers(property.value as PositionedNode);
    });
  }
  return [];
}

function isReferenceIdentifier(node: PositionedNode, parent?: PositionedNode): boolean {
  if (node.type !== "Identifier" || !parent) return false;
  if (
    (parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ClassDeclaration" ||
      parent.type === "ClassExpression") &&
    parent.id === node
  ) {
    return false;
  }
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if (
    parent.type === "ImportSpecifier" ||
    parent.type === "ImportDefaultSpecifier" ||
    parent.type === "ImportNamespaceSpecifier"
  ) {
    return false;
  }
  if (parent.type === "ExportSpecifier") return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return false;
  }
  if (
    (parent.type === "Property" || parent.type === "MethodDefinition") &&
    parent.key === node &&
    !parent.computed &&
    !(parent.type === "Property" && parent.shorthand)
  ) {
    return false;
  }
  if (
    (parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
    parent.label === node
  ) {
    return false;
  }
  const parameters = "params" in parent ? (parent.params as unknown) : undefined;
  if (Array.isArray(parameters) && parameters.includes(node)) return false;
  if (parent.type === "CatchClause" && parent.param === node) return false;
  return true;
}

function walkAstWithAncestors(
  node: unknown,
  visit: (node: PositionedNode, parent?: PositionedNode, ancestors?: PositionedNode[]) => void,
  parent?: PositionedNode,
  ancestors: PositionedNode[] = [],
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAstWithAncestors(child, visit, parent, ancestors);
    return;
  }

  const current = node as PositionedNode;
  if (typeof current.type !== "string") return;
  visit(current, parent, ancestors);
  const childAncestors = [...ancestors, current];
  for (const [key, value] of Object.entries(current)) {
    if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAstWithAncestors(child, visit, current, childAncestors);
    } else if (value && typeof value === "object") {
      walkAstWithAncestors(value, visit, current, childAncestors);
    }
  }
}

function renderImportDeclaration(
  code: string,
  statement: PositionedNode,
  removed: Set<PositionedNode>,
): string {
  const kept = (statement.specifiers as PositionedNode[]).filter(
    (specifier) => !removed.has(specifier),
  );
  if (kept.length === 0) return "";

  const defaultSpecifier = kept.find((specifier) => specifier.type === "ImportDefaultSpecifier");
  const namespaceSpecifier = kept.find(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  );
  const namedSpecifiers = kept.filter((specifier) => specifier.type === "ImportSpecifier");
  const clauses: string[] = [];
  if (defaultSpecifier) clauses.push(code.slice(defaultSpecifier.start, defaultSpecifier.end));
  if (namespaceSpecifier) {
    clauses.push(code.slice(namespaceSpecifier.start, namespaceSpecifier.end));
  }
  if (namedSpecifiers.length > 0) {
    clauses.push(
      `{ ${namedSpecifiers.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }`,
    );
  }

  return `import ${clauses.join(", ")} from ${code.slice(statement.source.start, statement.end)}`;
}

function renderExportDeclaration(
  code: string,
  statement: PositionedNode,
  removed: Set<PositionedNode>,
): string {
  const kept = (statement.specifiers as PositionedNode[]).filter(
    (specifier) => !removed.has(specifier),
  );
  if (kept.length === 0) return "";
  return `export { ${kept.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }${
    statement.source ? ` from ${code.slice(statement.source.start, statement.end)}` : ";"
  }`;
}

/**
 * Render a binding or assignment pattern without the removed names. `slice`
 * copies kept subexpressions (defaults, computed keys) so callers can apply
 * edits nested inside them.
 */
function renderBindingPattern(
  slice: (start: number, end: number) => string,
  pattern: PositionedNode,
  removedNames: ReadonlySet<string>,
): string | null {
  if (pattern.type === "Identifier") {
    return removedNames.has(pattern.name) ? null : pattern.name;
  }
  if (pattern.type === "MemberExpression") {
    const root = assignmentTargetIdentifiers(pattern)[0];
    return root && removedNames.has(root.name) ? null : slice(pattern.start, pattern.end);
  }
  if (pattern.type === "RestElement") {
    const argument = renderBindingPattern(slice, pattern.argument as PositionedNode, removedNames);
    return argument ? `...${argument}` : null;
  }
  if (pattern.type === "AssignmentPattern") {
    const left = renderBindingPattern(slice, pattern.left as PositionedNode, removedNames);
    return left ? `${left} = ${slice(pattern.right.start, pattern.right.end)}` : null;
  }
  if (pattern.type === "ObjectPattern") {
    const properties = (pattern.properties as PositionedNode[]).flatMap((property) => {
      if (property.type === "RestElement") {
        const rendered = renderBindingPattern(slice, property, removedNames);
        return rendered ? [rendered] : [];
      }
      const value = renderBindingPattern(slice, property.value as PositionedNode, removedNames);
      if (!value) return [];
      if (property.shorthand && property.value.type === "Identifier") return [value];
      const key = slice(property.key.start, property.key.end);
      return [`${property.computed ? `[${key}]` : key}: ${value}`];
    });
    return properties.length > 0 ? `{ ${properties.join(", ")} }` : null;
  }
  if (pattern.type === "ArrayPattern") {
    const elements = (pattern.elements as Array<PositionedNode | null>).map((element) =>
      element ? renderBindingPattern(slice, element, removedNames) : null,
    );
    while (elements.length > 0 && elements.at(-1) === null) elements.pop();
    return elements.length > 0 ? `[${elements.map((element) => element ?? "").join(", ")}]` : null;
  }
  return slice(pattern.start, pattern.end);
}

/** Pattern parts `renderBindingPattern` drops, including their defaults and keys. */
function prunedPatternParts(
  pattern: PositionedNode,
  removedNames: ReadonlySet<string>,
): PositionedNode[] {
  const isPruned = (part: PositionedNode) =>
    renderBindingPattern((start, end) => "".padEnd(end - start), part, removedNames) === null;
  if (isPruned(pattern)) return [pattern];
  if (pattern.type === "AssignmentPattern") {
    return prunedPatternParts(pattern.left as PositionedNode, removedNames);
  }
  if (pattern.type === "RestElement") {
    return prunedPatternParts(pattern.argument as PositionedNode, removedNames);
  }
  if (pattern.type === "ArrayPattern") {
    return (pattern.elements as Array<PositionedNode | null>).flatMap((element) =>
      element ? prunedPatternParts(element, removedNames) : [],
    );
  }
  if (pattern.type === "ObjectPattern") {
    return (pattern.properties as PositionedNode[]).flatMap((property) => {
      if (property.type === "RestElement") return prunedPatternParts(property, removedNames);
      return isPruned(property.value as PositionedNode)
        ? [property]
        : prunedPatternParts(property.value as PositionedNode, removedNames);
    });
  }
  return [];
}

/** Identifiers an assignment target writes: pattern bindings and member roots. */
function assignmentTargetIdentifiers(node: PositionedNode | null | undefined): PositionedNode[] {
  if (!node) return [];
  if (node.type === "Identifier") return [node];
  if (node.type === "MemberExpression") {
    return assignmentTargetIdentifiers(node.object as PositionedNode);
  }
  if (node.type === "RestElement")
    return assignmentTargetIdentifiers(node.argument as PositionedNode);
  if (node.type === "AssignmentPattern")
    return assignmentTargetIdentifiers(node.left as PositionedNode);
  if (node.type === "ArrayPattern") {
    return node.elements.flatMap((element: PositionedNode | null) =>
      assignmentTargetIdentifiers(element),
    );
  }
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property: PositionedNode) =>
      assignmentTargetIdentifiers(
        (property.type === "RestElement" ? property.argument : property.value) as PositionedNode,
      ),
    );
  }
  return [];
}

function isAssignmentTargetIdentifier(node: PositionedNode, left: PositionedNode): boolean {
  return assignmentTargetIdentifiers(left).some((identifier) => identifier.start === node.start);
}

function findLexicalScope(ancestors: PositionedNode[]): PositionedNode | undefined {
  return [...ancestors]
    .reverse()
    .find((ancestor) =>
      [
        "BlockStatement",
        "SwitchStatement",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "StaticBlock",
      ].includes(ancestor.type),
    );
}

export function validatePageExports(code: string): void {
  if (!hasExportAllCandidate(code)) return;
  let ast: ParsedAst;
  try {
    ast = parseAst(code);
  } catch {
    return;
  }
  if (
    (ast.body as PositionedNode[]).some((statement) => statement.type === "ExportAllDeclaration")
  ) {
    throw new Error(EXPORT_ALL_IN_PAGE_ERROR);
  }
}

type StripServerExportsResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

/**
 * Strip server-only Pages Router data-fetching exports and their unique
 * dependency graph from browser bundles.
 *
 * Ported from Next.js:
 * - test/unit/babel-plugin-next-ssg-transform.test.ts
 * - crates/next-custom-transforms/src/transforms/strip_page_exports.rs
 */
export function stripServerExports(code: string): StripServerExportsResult | null {
  if (!hasServerExportCandidate(code) && !hasExportAllCandidate(code)) {
    return null;
  }

  let ast: ParsedAst;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const statements = ast.body as PositionedNode[];
  validatePageExports(code);

  const edits: Edit[] = [];
  const deadRanges: Array<{ start: number; end: number }> = [];
  const deadRangeKeys = new Set<string>();
  const addDeadRange = (range: PositionedNode): boolean => {
    const key = `${range.start}:${range.end}`;
    if (deadRangeKeys.has(key)) return false;
    deadRangeKeys.add(key);
    deadRanges.push(range);
    return true;
  };

  const forcedBindings = new Set<string>();
  const candidateBindings = new Set<string>();
  const bindings = new Map<string, Binding>();
  const redeclarations: Binding[] = [];
  const loopHeadDeclarations = new Set<PositionedNode>();
  const declarationsOf = (name: string): Binding[] => {
    const binding = bindings.get(name);
    return [
      ...(binding ? [binding] : []),
      ...redeclarations.filter((redeclaration) => redeclaration.name === name),
    ];
  };
  const renderEdit = (edit: Edit): string =>
    typeof edit.replacement === "function" ? edit.replacement() : edit.replacement;
  // Copies kept source with the outermost edits inside it applied. Callers
  // only pass ranges strictly inside their own edit, so this cannot recurse
  // into the edit being rendered.
  const renderRange = (start: number, end: number): string => {
    const nested = edits
      .filter((edit) => edit.start >= start && edit.end <= end)
      .sort((left, right) => left.start - right.start || right.end - left.end);
    let rendered = "";
    let cursor = start;
    for (const edit of nested) {
      if (edit.start < cursor) continue;
      rendered += code.slice(cursor, edit.start) + renderEdit(edit);
      cursor = edit.end;
    }
    return rendered + code.slice(cursor, end);
  };
  const bindingPositions = new Set<number>();
  const references = new Map<string, number[]>();
  const shadowRanges = new Map<string, Array<{ start: number; end: number }>>();
  const exportSpecifierRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const variableRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const importRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const assignments: Array<{
    expression: PositionedNode;
    statement: PositionedNode | undefined;
    topLevel: boolean;
    bindingNames: string[];
    /** A `for…in/of` loop whose head writes the bindings. */
    loop?: boolean;
  }> = [];
  const removedAssignments = new Set<PositionedNode>();

  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      bindingPositions.add(declaration.id.start);
      bindings.set(declaration.id.name, {
        name: declaration.id.name,
        node: declaration,
        parent: statement,
        kind: "function",
        implementation: declaration,
        declaredNames: [declaration.id.name],
      });
    } else if (declaration?.type === "ClassDeclaration" && declaration.id) {
      bindingPositions.add(declaration.id.start);
      bindings.set(declaration.id.name, {
        name: declaration.id.name,
        node: declaration,
        parent: statement,
        kind: "class",
        implementation: declaration,
        declaredNames: [declaration.id.name],
      });
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations as PositionedNode[]) {
        const declaredNames = bindingNames(declarator.id as PositionedNode);
        for (const identifier of bindingIdentifiers(declarator.id as PositionedNode)) {
          bindingPositions.add(identifier.start);
        }
        for (const name of declaredNames) {
          bindings.set(name, {
            name,
            node: declarator,
            parent: declaration,
            kind: "variable",
            implementation: (declarator.init as PositionedNode | null) ?? declarator,
            declaredNames,
          });
        }
      }
    } else if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers as PositionedNode[]) {
        const name = getAstName(specifier.local);
        if (!name) continue;
        bindingPositions.add(specifier.local.start);
        bindings.set(name, {
          name,
          node: specifier,
          parent: statement,
          kind: "import",
          implementation: specifier,
          declaredNames: [name],
        });
      }
    }
  }

  const addShadowRange = (name: string, range: PositionedNode | undefined): void => {
    if (!range || range.type === "Program") return;
    const ranges = shadowRanges.get(name) ?? [];
    ranges.push(range);
    shadowRanges.set(name, ranges);
  };

  walkAstWithAncestors(ast.body, (node, parent, ancestors = []) => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const parameter of node.params as PositionedNode[]) {
        for (const name of bindingNames(parameter)) addShadowRange(name, node);
      }
      if (node.type === "FunctionDeclaration" && node.id) {
        addShadowRange(node.id.name, findLexicalScope(ancestors));
      } else if (node.type === "FunctionExpression" && node.id) {
        addShadowRange(node.id.name, node);
      }
    } else if (node.type === "ClassDeclaration" && node.id) {
      addShadowRange(node.id.name, findLexicalScope(ancestors));
    } else if (node.type === "ClassExpression" && node.id) {
      addShadowRange(node.id.name, node);
    } else if (node.type === "CatchClause" && node.param) {
      // The catch scope covers the parameter's own defaults as well.
      for (const name of bindingNames(node.param as PositionedNode)) addShadowRange(name, node);
    } else if (node.type === "VariableDeclarator" && parent?.type === "VariableDeclaration") {
      const varScope =
        parent.kind === "var"
          ? [...ancestors]
              .reverse()
              .find((ancestor) =>
                [
                  "FunctionDeclaration",
                  "FunctionExpression",
                  "ArrowFunctionExpression",
                  "StaticBlock",
                ].includes(ancestor.type),
              )
          : undefined;
      // A function's `var` is not visible from its parameter defaults, which
      // have their own scope, so the shadow starts at the body.
      const scope =
        parent.kind === "var"
          ? varScope?.type === "StaticBlock"
            ? varScope
            : (varScope?.body as PositionedNode | undefined)
          : findLexicalScope(ancestors);
      for (const name of bindingNames(node.id as PositionedNode)) addShadowRange(name, scope);
      // A `var` nested in a block outside any function is hoisted to module
      // scope, so `export { getServerSideProps }` can name it.
      const owner = ancestors.at(-2);
      if (parent.kind === "var" && !varScope && owner && owner.type !== "ExportNamedDeclaration") {
        if (owner.init === parent || owner.left === parent) loopHeadDeclarations.add(parent);
        const declaredNames = bindingNames(node.id as PositionedNode);
        for (const identifier of bindingIdentifiers(node.id as PositionedNode)) {
          bindingPositions.add(identifier.start);
        }
        for (const identifier of bindingIdentifiers(node.id as PositionedNode)) {
          const name = identifier.name;
          // A `var` redeclaring a catch parameter writes the catch binding.
          if (isInsideRanges(identifier.start, shadowRanges.get(name) ?? [])) continue;
          const binding: Binding = {
            name,
            node,
            parent,
            kind: "variable",
            implementation: (node.init as PositionedNode | null) ?? node,
            declaredNames,
          };
          // `var` may redeclare a name, e.g. once per branch of an if/else;
          // every declarator goes with the binding.
          if (bindings.has(name)) redeclarations.push(binding);
          else bindings.set(name, binding);
        }
      }
    }
  });

  walkAstWithAncestors(ast.body, (node, parent, ancestors = []) => {
    if (node.type === "AssignmentExpression") {
      // Assignments are collected at any depth: one inside a conditional
      // branch must go with the binding it targets, or the assignment and
      // the server-only code on its right-hand side stay in the browser graph.
      const names = assignmentTargetIdentifiers(node.left as PositionedNode)
        .filter(
          (identifier) =>
            !isInsideRanges(identifier.start, shadowRanges.get(identifier.name) ?? []),
        )
        .map((identifier) => identifier.name);
      if (names.length > 0) {
        const statement =
          parent?.type === "ExpressionStatement" && parent.expression === node ? parent : undefined;
        assignments.push({
          expression: node,
          statement,
          topLevel: statement !== undefined && ancestors.length === 1,
          bindingNames: names,
        });
      }
      return;
    }
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      // The head is written from the iterable, which is the right-hand side
      // here, so a loop writing a removed binding is removed as a whole.
      const left = node.left as PositionedNode;
      const names = (
        left.type === "VariableDeclaration"
          ? bindingIdentifiers(left.declarations[0]?.id as PositionedNode)
          : assignmentTargetIdentifiers(left)
      )
        .filter(
          (identifier) =>
            !isInsideRanges(identifier.start, shadowRanges.get(identifier.name) ?? []),
        )
        .map((identifier) => identifier.name);
      if (names.length > 0) {
        assignments.push({
          expression: node,
          statement: node,
          topLevel: ancestors.length === 0,
          bindingNames: names,
          loop: true,
        });
      }
      return;
    }
    if (!isReferenceIdentifier(node, parent)) return;
    if (bindingPositions.has(node.start)) return;
    if (isInsideRanges(node.start, shadowRanges.get(node.name) ?? [])) return;
    const writer = [...ancestors]
      .reverse()
      .find(
        (ancestor) =>
          ancestor.type === "AssignmentExpression" ||
          ((ancestor.type === "ForInStatement" || ancestor.type === "ForOfStatement") &&
            node.start >= ancestor.left.start &&
            node.end <= ancestor.left.end),
      );
    if (writer && isAssignmentTargetIdentifier(node, writer.left as PositionedNode)) return;
    const positions = references.get(node.name) ?? [];
    positions.push(node.start);
    references.set(node.name, positions);
  });

  let hasServerProps = false;
  let hasStaticProps = false;
  const noteDataExport = (name: string): void => {
    if (name === "getServerSideProps") hasServerProps = true;
    else hasStaticProps = true;
    if (hasServerProps && hasStaticProps) throw new Error(SERVER_PROPS_SSG_CONFLICT);
  };

  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration") continue;

    if (statement.declaration?.type === "FunctionDeclaration" && statement.declaration.id) {
      const name = statement.declaration.id.name;
      if (SERVER_EXPORTS.has(name)) {
        noteDataExport(name);
        forcedBindings.add(name);
        addDeadRange(statement.declaration);
        edits.push({ start: statement.start, end: statement.end, replacement: "" });
      }
      continue;
    }

    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declarator of statement.declaration.declarations as PositionedNode[]) {
        for (const name of bindingNames(declarator.id as PositionedNode)) {
          if (!SERVER_EXPORTS.has(name)) continue;
          noteDataExport(name);
          forcedBindings.add(name);
          if (declarator.init) addDeadRange(declarator.init as PositionedNode);
          const removals = variableRemovals.get(statement.declaration) ?? new Set<PositionedNode>();
          removals.add(declarator);
          variableRemovals.set(statement.declaration, removals);
        }
      }
      continue;
    }

    const removed = new Set<PositionedNode>();
    for (const specifier of statement.specifiers as PositionedNode[]) {
      const exportedName = getAstName(specifier.exported);
      if (exportedName && SERVER_EXPORTS.has(exportedName)) {
        noteDataExport(exportedName);
        removed.add(specifier);
        if (!statement.source) {
          const localName = getAstName(specifier.local);
          if (localName) candidateBindings.add(localName);
        }
      } else if (!statement.source) {
        const localName = getAstName(specifier.local);
        if (localName) {
          const positions = references.get(localName) ?? [];
          positions.push(specifier.local.start);
          references.set(localName, positions);
        }
      }
    }
    if (removed.size > 0) exportSpecifierRemovals.set(statement, removed);
  }

  const deadBindings = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;

    for (const { expression, statement, topLevel, bindingNames: names, loop } of assignments) {
      const removableNames = new Set(
        names.filter((name) => forcedBindings.has(name) || deadBindings.has(name)),
      );
      if (removableNames.size === 0) continue;
      if (removedAssignments.has(expression)) continue;
      if (loop) {
        removedAssignments.add(expression);
        const head = expression.left as PositionedNode;
        const pattern =
          head.type === "VariableDeclaration" ? (head.declarations[0].id as PositionedNode) : head;
        if (renderBindingPattern((start, end) => code.slice(start, end), pattern, removableNames)) {
          // Other head targets stay live, so only the removed ones are pruned;
          // a `var` head is re-rendered with its declaration.
          for (const part of prunedPatternParts(pattern, removableNames)) {
            if (addDeadRange(part)) changed = true;
          }
          if (head.type !== "VariableDeclaration") {
            edits.push({
              start: head.start,
              end: head.end,
              replacement: () => renderBindingPattern(renderRange, head, removableNames)!,
            });
          }
          continue;
        }
        edits.push({
          start: expression.start,
          end: expression.end,
          replacement: topLevel ? "" : ";",
        });
        if (addDeadRange(expression)) changed = true;
        continue;
      }
      const left = expression.left as PositionedNode;
      const renderedLeft =
        left.type === "ArrayPattern" || left.type === "ObjectPattern"
          ? renderBindingPattern((start, end) => code.slice(start, end), left, removableNames)
          : null;
      const right = expression.right as PositionedNode;
      const renderRight = () => renderRange(right.start, right.end);
      removedAssignments.add(expression);
      const target = statement ?? expression;
      if (renderedLeft) {
        for (const part of prunedPatternParts(left, removableNames)) {
          if (addDeadRange(part)) changed = true;
        }
        edits.push({
          start: target.start,
          end: target.end,
          replacement: () => {
            const pattern = renderBindingPattern(renderRange, left, removableNames);
            const assignment = `${pattern} ${expression.operator} ${renderRight()}`;
            if (!statement) return `(${assignment})`;
            return left.type === "ObjectPattern" ? `(${assignment});` : `${assignment};`;
          },
        });
        continue;
      }
      // In expression position a dead helper's assignment still yields its
      // right-hand side, as in Turbopack. A data export's right-hand side is
      // the server-only code being removed, so that assignment becomes `void 0`.
      if (
        !statement &&
        ![...removableNames].some((name) => forcedBindings.has(name) || candidateBindings.has(name))
      ) {
        edits.push({
          start: target.start,
          end: target.end,
          replacement: () => `(${renderRight()})`,
        });
        continue;
      }
      // A nested statement may be the only body of an `if` or loop, so it
      // becomes an empty statement rather than disappearing.
      edits.push({
        start: target.start,
        end: target.end,
        replacement: statement ? (topLevel ? "" : ";") : "void 0",
      });
      if (addDeadRange(target)) changed = true;
    }

    const removableBindings = new Set<string>();
    for (const [name] of bindings) {
      if (
        forcedBindings.has(name) ||
        candidateBindings.has(name) ||
        (references.get(name) ?? []).some((position) => isInsideRanges(position, deadRanges))
      ) {
        removableBindings.add(name);
      }
    }
    let closureChanged = true;
    while (closureChanged) {
      closureChanged = false;
      const implementations = [...removableBindings].flatMap((name) =>
        declarationsOf(name).map((binding) => binding.implementation),
      );
      for (const [name] of bindings) {
        if (removableBindings.has(name)) continue;
        if (
          (references.get(name) ?? []).some((position) => isInsideRanges(position, implementations))
        ) {
          removableBindings.add(name);
          closureChanged = true;
        }
      }
    }
    let pruneChanged = true;
    while (pruneChanged) {
      pruneChanged = false;
      const implementations = [...removableBindings].flatMap((name) =>
        declarationsOf(name).map((binding) => binding.implementation),
      );
      for (const name of removableBindings) {
        if (forcedBindings.has(name)) continue;
        const hasLiveReference = (references.get(name) ?? []).some(
          (position) =>
            !isInsideRanges(position, deadRanges) && !isInsideRanges(position, implementations),
        );
        if (hasLiveReference) {
          removableBindings.delete(name);
          pruneChanged = true;
        }
      }
    }
    for (const name of removableBindings) {
      if (deadBindings.has(name)) continue;
      const binding = bindings.get(name);
      if (!binding) continue;
      deadBindings.add(name);
      changed = true;
      if (binding.kind === "function" || binding.kind === "class") {
        addDeadRange(binding.implementation);
      }
    }

    for (const binding of new Set([...bindings.values(), ...redeclarations])) {
      if (binding.kind !== "variable") continue;
      if (!binding.declaredNames.every((name) => deadBindings.has(name))) {
        // Defaults and computed keys of pruned pattern parts go with them.
        for (const part of prunedPatternParts(binding.node.id as PositionedNode, deadBindings)) {
          if (addDeadRange(part)) changed = true;
        }
        continue;
      }
      if (addDeadRange(binding.implementation)) changed = true;
    }
  }

  for (const binding of [...deadBindings].flatMap(declarationsOf)) {
    const name = binding.name;
    if (forcedBindings.has(name)) {
      if (
        (binding.kind === "function" || binding.kind === "class") &&
        binding.parent.type !== "ExportNamedDeclaration"
      ) {
        edits.push({
          start: binding.node.start,
          end: binding.node.end,
          replacement: binding.kind === "function" ? `function ${name}() {}` : `class ${name} {}`,
        });
      } else if (binding.kind === "variable" && binding.parent.type !== "ExportNamedDeclaration") {
        const removals = variableRemovals.get(binding.parent) ?? new Set<PositionedNode>();
        removals.add(binding.node);
        variableRemovals.set(binding.parent, removals);
      } else if (binding.kind === "import") {
        const removals = importRemovals.get(binding.parent) ?? new Set<PositionedNode>();
        removals.add(binding.node);
        importRemovals.set(binding.parent, removals);
      }
      continue;
    }

    if (binding.kind === "import") {
      const removals = importRemovals.get(binding.parent) ?? new Set<PositionedNode>();
      removals.add(binding.node);
      importRemovals.set(binding.parent, removals);
    } else if (binding.kind === "variable") {
      const removals = variableRemovals.get(binding.parent) ?? new Set<PositionedNode>();
      removals.add(binding.node);
      variableRemovals.set(binding.parent, removals);
    } else {
      edits.push({ start: binding.parent.start, end: binding.parent.end, replacement: "" });
    }
  }

  for (const [statement, removed] of exportSpecifierRemovals) {
    edits.push({
      start: statement.start,
      end: statement.end,
      replacement: renderExportDeclaration(code, statement, removed),
    });
  }
  for (const [declaration, removed] of variableRemovals) {
    const exportStatement = statements.find(
      (statement) =>
        statement.type === "ExportNamedDeclaration" && statement.declaration === declaration,
    );
    edits.push({
      start: exportStatement?.start ?? declaration.start,
      end: declaration.end,
      replacement: () => {
        const rendered = (declaration.declarations as PositionedNode[]).flatMap((declarator) => {
          if (!removed.has(declarator)) return [renderRange(declarator.start, declarator.end)];
          const pattern = renderBindingPattern(
            renderRange,
            declarator.id as PositionedNode,
            deadBindings,
          );
          if (!pattern) return [];
          return [
            `${pattern}${declarator.init ? ` = ${renderRange(declarator.init.start, declarator.init.end)}` : ""}`,
          ];
        });
        if (rendered.length > 0) {
          const terminator = loopHeadDeclarations.has(declaration) ? "" : ";";
          return `${exportStatement ? "export " : ""}${declaration.kind} ${rendered.join(", ")}${terminator}`;
        }
        return exportStatement ||
          statements.includes(declaration) ||
          loopHeadDeclarations.has(declaration)
          ? ""
          : ";";
      },
    });
  }
  for (const [statement, removed] of importRemovals) {
    edits.push({
      start: statement.start,
      end: statement.end,
      replacement: renderImportDeclaration(code, statement, removed),
    });
  }

  if (edits.length === 0) return null;

  const string = new MagicString(code);
  const uniqueEdits = [
    ...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values(),
  ].sort((left, right) => left.start - right.start || right.end - left.end);
  // Nested assignments can sit inside a range that is already being removed or
  // re-rendered; the outermost edit wins and renders any nested edits itself.
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const edit of uniqueEdits) {
    if (edit.start < lastEnd) continue;
    string.overwrite(edit.start, edit.end, renderEdit(edit));
    lastEnd = edit.end;
  }
  // The MagicString already tracks every overwrite, so emit its sourcemap
  // instead of dropping it — removing whole statements shifts line numbers for
  // the rest of the module, which would otherwise break client-build debugging.
  return magicStringTransformResult(string);
}
