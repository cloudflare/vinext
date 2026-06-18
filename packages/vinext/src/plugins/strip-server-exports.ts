import { parseAst } from "vite";
import MagicString from "magic-string";

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
  return [...SERVER_EXPORTS].some((name) => code.includes(name));
}

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

type Edit = { start: number; end: number; replacement: string };

function nodeName(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = node as { name?: string; value?: string };
  return value.name ?? value.value;
}

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

function walkAst(
  node: unknown,
  visit: (node: PositionedNode, parent?: PositionedNode, ancestors?: PositionedNode[]) => void,
  parent?: PositionedNode,
  ancestors: PositionedNode[] = [],
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit, parent, ancestors);
    return;
  }

  const current = node as PositionedNode;
  if (typeof current.type !== "string") return;
  visit(current, parent, ancestors);
  const childAncestors = [...ancestors, current];
  for (const [key, value] of Object.entries(current)) {
    if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, current, childAncestors);
    } else if (value && typeof value === "object") {
      walkAst(value, visit, current, childAncestors);
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

function renderBindingPattern(
  code: string,
  pattern: PositionedNode,
  removedNames: ReadonlySet<string>,
): string | null {
  if (pattern.type === "Identifier") {
    return removedNames.has(pattern.name) ? null : pattern.name;
  }
  if (pattern.type === "RestElement") {
    const argument = renderBindingPattern(code, pattern.argument as PositionedNode, removedNames);
    return argument ? `...${argument}` : null;
  }
  if (pattern.type === "AssignmentPattern") {
    const left = renderBindingPattern(code, pattern.left as PositionedNode, removedNames);
    return left ? `${left} = ${code.slice(pattern.right.start, pattern.right.end)}` : null;
  }
  if (pattern.type === "ObjectPattern") {
    const properties = (pattern.properties as PositionedNode[]).flatMap((property) => {
      if (property.type === "RestElement") {
        const rendered = renderBindingPattern(code, property, removedNames);
        return rendered ? [rendered] : [];
      }
      const value = renderBindingPattern(code, property.value as PositionedNode, removedNames);
      if (!value) return [];
      if (property.shorthand && property.value.type === "Identifier") return [value];
      const key = code.slice(property.key.start, property.key.end);
      return [`${property.computed ? `[${key}]` : key}: ${value}`];
    });
    return properties.length > 0 ? `{ ${properties.join(", ")} }` : null;
  }
  if (pattern.type === "ArrayPattern") {
    const elements = (pattern.elements as Array<PositionedNode | null>).map((element) =>
      element ? renderBindingPattern(code, element, removedNames) : null,
    );
    while (elements.length > 0 && elements.at(-1) === null) elements.pop();
    return elements.length > 0 ? `[${elements.map((element) => element ?? "").join(", ")}]` : null;
  }
  return code.slice(pattern.start, pattern.end);
}

function assignmentRootName(node: PositionedNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return assignmentRootName(node.object as PositionedNode);
  return undefined;
}

function assignmentBindingNames(node: PositionedNode): string[] {
  if (node.type === "ArrayPattern" || node.type === "ObjectPattern") return bindingNames(node);
  const rootName = assignmentRootName(node);
  return rootName ? [rootName] : [];
}

function isAssignmentTargetIdentifier(node: PositionedNode, left: PositionedNode): boolean {
  if (left.type === "Identifier") return node.start === left.start;
  if (left.type === "ArrayPattern" || left.type === "ObjectPattern") {
    return bindingIdentifiers(left).some((identifier) => identifier.start === node.start);
  }
  if (left.type === "MemberExpression") {
    let object = left.object as PositionedNode;
    while (object.type === "MemberExpression") object = object.object as PositionedNode;
    return object.type === "Identifier" && object.start === node.start;
  }
  return false;
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
  const bindingPositions = new Set<number>();
  const references = new Map<string, number[]>();
  const shadowRanges = new Map<string, Array<{ start: number; end: number }>>();
  const exportSpecifierRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const variableRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const importRemovals = new Map<PositionedNode, Set<PositionedNode>>();
  const assignmentStatements: Array<{
    statement: PositionedNode;
    left: PositionedNode;
    bindingNames: string[];
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
        const name = nodeName(specifier.local);
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
    } else if (statement.type === "ExpressionStatement") {
      const expression = statement.expression as PositionedNode;
      if (expression.type === "AssignmentExpression") {
        const left = expression.left as PositionedNode;
        const names = assignmentBindingNames(left);
        if (names.length > 0) assignmentStatements.push({ statement, left, bindingNames: names });
      }
    }
  }

  const addShadowRange = (name: string, range: PositionedNode | undefined): void => {
    if (!range || range.type === "Program") return;
    const ranges = shadowRanges.get(name) ?? [];
    ranges.push(range);
    shadowRanges.set(name, ranges);
  };

  walkAst(ast.body, (node, parent, ancestors = []) => {
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
      for (const name of bindingNames(node.param as PositionedNode)) {
        addShadowRange(name, node.body as PositionedNode);
      }
    } else if (node.type === "VariableDeclarator" && parent?.type === "VariableDeclaration") {
      const scope =
        parent.kind === "var"
          ? [...ancestors]
              .reverse()
              .find((ancestor) =>
                ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
                  ancestor.type,
                ),
              )
          : findLexicalScope(ancestors);
      for (const name of bindingNames(node.id as PositionedNode)) addShadowRange(name, scope);
    }
  });

  walkAst(ast.body, (node, parent, ancestors = []) => {
    if (!isReferenceIdentifier(node, parent)) return;
    if (bindingPositions.has(node.start)) return;
    if (isInsideRanges(node.start, shadowRanges.get(node.name) ?? [])) return;
    const assignment = [...ancestors]
      .reverse()
      .find((ancestor) => ancestor.type === "AssignmentExpression");
    if (assignment && isAssignmentTargetIdentifier(node, assignment.left as PositionedNode)) return;
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
      const exportedName = nodeName(specifier.exported);
      if (exportedName && SERVER_EXPORTS.has(exportedName)) {
        noteDataExport(exportedName);
        removed.add(specifier);
        if (!statement.source) {
          const localName = nodeName(specifier.local);
          if (localName) candidateBindings.add(localName);
        }
      } else if (!statement.source) {
        const localName = nodeName(specifier.local);
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

    for (const { statement, left, bindingNames: names } of assignmentStatements) {
      const removableNames = new Set(
        names.filter((name) => forcedBindings.has(name) || deadBindings.has(name)),
      );
      if (removableNames.size === 0) continue;
      if (removedAssignments.has(statement)) continue;
      const expression = statement.expression as PositionedNode;
      const renderedLeft =
        left.type === "ArrayPattern" || left.type === "ObjectPattern"
          ? renderBindingPattern(code, left, removableNames)
          : null;
      removedAssignments.add(statement);
      edits.push({
        start: statement.start,
        end: statement.end,
        replacement: renderedLeft
          ? `${left.type === "ObjectPattern" ? `(${renderedLeft} ${expression.operator} ${code.slice(expression.right.start, expression.right.end)})` : `${renderedLeft} ${expression.operator} ${code.slice(expression.right.start, expression.right.end)}`};`
          : "",
      });
      if (!renderedLeft && addDeadRange(statement)) changed = true;
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
      const implementations = [...removableBindings]
        .map((name) => bindings.get(name)?.implementation)
        .filter((implementation): implementation is PositionedNode => Boolean(implementation));
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
      const implementations = [...removableBindings]
        .map((name) => bindings.get(name)?.implementation)
        .filter((implementation): implementation is PositionedNode => Boolean(implementation));
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

    for (const binding of new Set(bindings.values())) {
      if (binding.kind !== "variable") continue;
      if (!binding.declaredNames.every((name) => deadBindings.has(name))) continue;
      if (addDeadRange(binding.implementation)) changed = true;
    }
  }

  for (const name of deadBindings) {
    const binding = bindings.get(name);
    if (!binding) continue;

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
    const rendered = (declaration.declarations as PositionedNode[]).flatMap((declarator) => {
      if (!removed.has(declarator)) return [code.slice(declarator.start, declarator.end)];
      const pattern = renderBindingPattern(code, declarator.id as PositionedNode, deadBindings);
      if (!pattern) return [];
      return [
        `${pattern}${declarator.init ? ` = ${code.slice(declarator.init.start, declarator.init.end)}` : ""}`,
      ];
    });
    const exportStatement = statements.find(
      (statement) =>
        statement.type === "ExportNamedDeclaration" && statement.declaration === declaration,
    );
    edits.push({
      start: exportStatement?.start ?? declaration.start,
      end: declaration.end,
      replacement:
        rendered.length > 0
          ? `${exportStatement ? "export " : ""}${declaration.kind} ${rendered.join(", ")};`
          : "",
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
  ].sort((left, right) => right.start - left.start || right.end - left.end);
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of uniqueEdits) {
    if (edit.end > lastStart) continue;
    string.overwrite(edit.start, edit.end, edit.replacement);
    lastStart = edit.start;
  }
  // The MagicString already tracks every overwrite, so emit its sourcemap
  // instead of dropping it — removing whole statements shifts line numbers for
  // the rest of the module, which would otherwise break client-build debugging.
  return { code: string.toString(), map: string.generateMap({ hires: "boundary" }) };
}
