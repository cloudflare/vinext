import type { ESTree, Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { hasTrailingComma } from "../utils/has-trailing-comma.js";
import { relativeWithinRoot, tryRealpathSync } from "../build/ssr-manifest.js";
import { stripViteModuleQuery } from "../utils/path.js";
import { collectBindingNames, forEachAstChild, stringLiteralValue, walkAst } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

type TransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type ResolveDynamicImport = (specifier: string, importer: string) => Promise<string | null>;

function isNextDynamicSource(source: string | null): boolean {
  return source === "next/dynamic" || source === "next/dynamic.js";
}

function collectDynamicImportLocals(ast: ESTree.Program): Set<string> {
  const locals = new Set<string>();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    if (!isNextDynamicSource(stringLiteralValue(node.source))) continue;

    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") locals.add(specifier.local.name);
    }
  }

  return locals;
}

function isIdentifierNameInSet(node: ESTree.Node, names: Set<string>): boolean {
  return node.type === "Identifier" && names.has(node.name);
}

function isDynamicCall(
  node: ESTree.Node,
  dynamicLocals: Set<string>,
): node is ESTree.CallExpression {
  return node.type === "CallExpression" && isIdentifierNameInSet(node.callee, dynamicLocals);
}

function addBindingName(pattern: ESTree.Node | null, names: Set<string>): void {
  collectBindingNames(pattern, names);
}

function addVariableDeclarationBindingNames(node: ESTree.Node | null, names: Set<string>): void {
  if (node?.type !== "VariableDeclaration") return;
  for (const declaration of node.declarations) {
    addBindingName(declaration.id, names);
  }
}

function collectBlockScopedBindingNames(body: readonly ESTree.Node[]): Set<string> {
  const names = new Set<string>();

  for (const statement of body) {
    if (statement.type === "VariableDeclaration") {
      if (statement.kind !== "var") {
        addVariableDeclarationBindingNames(statement, names);
      }
      continue;
    }

    if (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id
    ) {
      names.add(statement.id.name);
    }
  }

  return names;
}

function collectSwitchScopedBindingNames(node: ESTree.SwitchStatement): Set<string> {
  const names = new Set<string>();

  for (const switchCase of node.cases) {
    for (const statement of switchCase.consequent) {
      for (const name of collectBlockScopedBindingNames([statement])) {
        names.add(name);
      }
    }
  }

  return names;
}

function collectVarBindingNames(value: ESTree.Node | null, names: Set<string>): void {
  if (!value) return;

  const type = value.type;
  if (
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression"
  ) {
    return;
  }

  if (type === "VariableDeclaration" && value.kind === "var") {
    addVariableDeclarationBindingNames(value, names);
  }

  forEachAstChild(value, (child) => collectVarBindingNames(child, names));
}

function collectFunctionScopeBindingNames(
  node: ESTree.Function | ESTree.ArrowFunctionExpression,
): Set<string> {
  const names = new Set<string>();

  if (node.type === "FunctionExpression" && node.id) {
    names.add(node.id.name);
  }

  for (const param of node.params) {
    addBindingName(param, names);
  }

  collectVarBindingNames(node.body, names);
  return names;
}

function collectForBindingNames(
  node: ESTree.ForStatement | ESTree.ForInStatement | ESTree.ForOfStatement,
): Set<string> {
  const names = new Set<string>();
  addVariableDeclarationBindingNames(node.type === "ForStatement" ? node.init : node.left, names);
  return names;
}

function withoutBindings(activeNames: Set<string>, localNames: Set<string>): Set<string> {
  if (activeNames.size === 0 || localNames.size === 0) return activeNames;

  let scoped: Set<string> | null = null;
  for (const name of localNames) {
    if (!activeNames.has(name)) continue;
    scoped ??= new Set(activeNames);
    scoped.delete(name);
  }

  return scoped ?? activeNames;
}

function visitChildren(
  node: ESTree.Node,
  dynamicLocals: Set<string>,
  visitor: (node: ESTree.CallExpression) => void,
): void {
  forEachAstChild(node, (child) => visitDynamicCalls(child, dynamicLocals, visitor));
}

function visitDynamicCalls(
  value: ESTree.Node,
  dynamicLocals: Set<string>,
  visitor: (node: ESTree.CallExpression) => void,
): void {
  if (dynamicLocals.size === 0) return;

  const type = value.type;
  if (type === "Program") {
    const scoped = withoutBindings(dynamicLocals, collectBlockScopedBindingNames(value.body));
    for (const statement of value.body) {
      visitDynamicCalls(statement, scoped, visitor);
    }
    return;
  }

  if (type === "BlockStatement") {
    const scoped = withoutBindings(dynamicLocals, collectBlockScopedBindingNames(value.body));
    for (const statement of value.body) {
      visitDynamicCalls(statement, scoped, visitor);
    }
    return;
  }

  if (type === "SwitchStatement") {
    visitDynamicCalls(value.discriminant, dynamicLocals, visitor);

    const scoped = withoutBindings(dynamicLocals, collectSwitchScopedBindingNames(value));
    for (const switchCase of value.cases) {
      visitDynamicCalls(switchCase, scoped, visitor);
    }
    return;
  }

  if (
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression"
  ) {
    visitChildren(
      value,
      withoutBindings(dynamicLocals, collectFunctionScopeBindingNames(value)),
      visitor,
    );
    return;
  }

  if (type === "ClassDeclaration" || type === "ClassExpression") {
    const names = new Set<string>();
    if (value.id) names.add(value.id.name);
    visitChildren(value, withoutBindings(dynamicLocals, names), visitor);
    return;
  }

  if (type === "ForStatement" || type === "ForInStatement" || type === "ForOfStatement") {
    visitChildren(value, withoutBindings(dynamicLocals, collectForBindingNames(value)), visitor);
    return;
  }

  if (type === "CatchClause") {
    const names = new Set<string>();
    addBindingName(value.param, names);
    visitChildren(value, withoutBindings(dynamicLocals, names), visitor);
    return;
  }

  if (isDynamicCall(value, dynamicLocals)) {
    visitor(value);
  }
  visitChildren(value, dynamicLocals, visitor);
}

function collectImportSpecifiers(node: ESTree.Node | undefined): string[] {
  const specifiers: string[] = [];
  const seen = new Set<string>();

  if (!node) return specifiers;
  walkAst(node, (item) => {
    if (item.type === "ImportExpression") {
      const specifier = stringLiteralValue(item.source);
      if (specifier && !seen.has(specifier)) {
        seen.add(specifier);
        specifiers.push(specifier);
      }
      return;
    }
  });

  return specifiers;
}

function propertyKeyName(property: ESTree.ObjectProperty): string | null {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  return stringLiteralValue(key);
}

function objectProperties(node: ESTree.Node | undefined): ESTree.ObjectProperty[] {
  if (node?.type !== "ObjectExpression") return [];
  return node.properties.filter(
    (property): property is ESTree.ObjectProperty => property.type === "Property",
  );
}

function hasObjectProperty(node: ESTree.Node | undefined, name: string): boolean {
  return objectProperties(node).some((property) => propertyKeyName(property) === name);
}

function findObjectProperty(node: ESTree.Node, name: string): ESTree.ObjectProperty | null {
  return objectProperties(node).find((property) => propertyKeyName(property) === name) ?? null;
}

function dynamicLoaderNode(firstArg: ESTree.Node | undefined): ESTree.Node | undefined {
  if (firstArg?.type !== "ObjectExpression") return firstArg;
  // For the object form `dynamic({ loader })`, scan the `loader` value. The
  // `modules` fallback mirrors Next.js's react-loadable babel plugin, which
  // treats `modules` as an alternate loader source (`propertiesMap.modules` →
  // `loader`) for the legacy `Loadable.Map` shape. In practice `modules` is
  // usually a string array (no `import()` calls), so collectImportSpecifiers
  // finds nothing and it's a harmless no-op — but we keep the branch for exact
  // parity with the function form Next.js still accepts.
  const loaderProperty =
    findObjectProperty(firstArg, "loader") ?? findObjectProperty(firstArg, "modules");
  return loaderProperty?.value;
}

function findLastObjectMember(node: ESTree.ObjectExpression): ESTree.ObjectPropertyKind | null {
  return node.properties.at(-1) ?? null;
}

function appendObjectProperty(
  output: MagicString,
  objectNode: ESTree.ObjectExpression,
  property: string,
): boolean {
  const lastMember = findLastObjectMember(objectNode);
  if (!lastMember) {
    output.appendLeft(objectNode.start + 1, property);
    return true;
  }

  output.appendLeft(lastMember.end, `, ${property}`);
  return true;
}

function insertSecondOptionsArgument(
  output: MagicString,
  code: string,
  callNode: ESTree.CallExpression,
  firstArg: ESTree.Argument,
  optionsLiteral: string,
): boolean {
  // Insert just before the call's closing paren (AST `end` is exclusive, so
  // `callEnd - 1` is the `)`). This is PAREN-SAFE: a parenthesized first
  // argument such as `dynamic((() => import("./x")))` reports its `end` BEFORE
  // the wrapping paren, so inserting at the first arg's end would land inside
  // those parens and turn the loader into a sequence expression — silently
  // dropping it. The call's close paren is always past the whole argument list.
  const closeParen = callNode.end - 1;

  // Decide the separator with a COMMENT-AWARE trailing-comma check:
  // `hasTrailingComma` inspects only the gap between the first argument and the
  // close paren, ignoring trailing whitespace/comments (and never treating a
  // `//`/`/*` inside a string literal as a comment). A pre-existing trailing
  // comma (`dynamic(loader,)`) must NOT get a second one (`,,` is a syntax
  // error), and a comma living inside a comment must NOT be mistaken for a real
  // one (the old substring scan overwrote — and thus ate — such comments).
  const separator = hasTrailingComma(code.slice(firstArg.end, closeParen)) ? " " : ", ";
  output.appendLeft(closeParen, `${separator}${optionsLiteral}`);
  return true;
}

function cleanResolvedId(id: string): string {
  let start = 0;
  while (start < id.length && id.charCodeAt(start) === 0) {
    start += 1;
  }

  return toSlash(stripViteModuleQuery(id.slice(start).replace(/^\/@fs\//, "/")));
}

// `toManifestModuleId` runs once per resolved specifier but `root` is constant
// for the whole build, so memoise its realpath instead of stat-ing the FS on
// every call. The cache intentionally lives for the process lifetime: it is
// keyed by absolute root path and a root's realpath is stable for any realistic
// build/dev session (the only staleness would be swapping a root symlink target
// mid-process, which does not happen).
const rootRealpathCache = new Map<string, string | null>();
function cachedRootRealpath(root: string): string | null {
  if (!rootRealpathCache.has(root)) {
    rootRealpathCache.set(root, tryRealpathSync(root));
  }
  return rootRealpathCache.get(root) ?? null;
}

/** `code` offset -> human `:line:column` (1-based), for build error messages. */
function formatNodeLocation(code: string, node: ESTree.Node): string {
  const before = code.slice(0, node.start);
  const line = before.split("\n").length;
  const column = node.start - before.lastIndexOf("\n");
  return `:${line}:${column}`;
}

function toManifestModuleId(root: string, resolvedId: string): string | null {
  const cleaned = cleanResolvedId(resolvedId);
  if (!path.isAbsolute(cleaned)) return cleaned.replace(/^\/+/, "");

  // Resolve symlinks on BOTH sides before computing the root-relative key.
  // pnpm stores dependencies behind symlinks and the project root itself may be
  // symlinked, so `this.resolve()` can hand back a realpath that does not share
  // the (possibly symlinked) `root` prefix. Without this, `path.relative` yields
  // a `../…` escape, the module is dropped, and the preload silently disappears
  // — exactly in vinext's primary pnpm/Cloudflare setups. Reuses the same
  // realpath-candidate strategy as the SSR-manifest module-id normaliser.
  //
  // NB: this realpaths both sides, while the preload map is keyed by Vite's raw
  // manifest key (`computeDynamicImportPreloads`). They agree because Vite's
  // default `resolve.preserveSymlinks: false` already emits realpath-relative
  // manifest keys; under `preserveSymlinks: true` the two key-spaces could
  // diverge (the lookup would miss and the preload would be skipped — no crash).
  const rootCandidates = new Set<string>([root]);
  const realRoot = cachedRootRealpath(root);
  if (realRoot) rootCandidates.add(toSlash(realRoot));

  const moduleCandidates = new Set<string>([cleaned]);
  const realCleaned = tryRealpathSync(cleaned);
  if (realCleaned) moduleCandidates.add(toSlash(realCleaned));

  for (const rootCandidate of rootCandidates) {
    for (const moduleCandidate of moduleCandidates) {
      const relative = relativeWithinRoot(rootCandidate, moduleCandidate);
      if (relative) return relative;
    }
  }
  return null;
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

function shouldSkipCall(firstArg: ESTree.Node, secondArg: ESTree.Node | undefined): boolean {
  if (hasObjectProperty(firstArg, "loadableGenerated")) return true;
  return hasObjectProperty(secondArg, "loadableGenerated");
}

function applyLoadableGenerated(
  output: MagicString,
  code: string,
  callNode: ESTree.CallExpression,
  moduleIds: readonly string[],
): boolean {
  const args = callNode.arguments;
  const firstArg = args[0];
  const secondArg = args[1];
  if (!firstArg) return false;
  if (shouldSkipCall(firstArg, secondArg)) return false;

  const property = `loadableGenerated: { modules: ${JSON.stringify(moduleIds)} }`;
  const firstArgIsObject = firstArg.type === "ObjectExpression";
  if (firstArgIsObject) {
    return appendObjectProperty(output, firstArg, property);
  }

  if (secondArg === undefined) {
    return insertSecondOptionsArgument(output, code, callNode, firstArg, `{ ${property} }`);
  }

  if (secondArg?.type === "ObjectExpression") {
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
  if (!code.includes("next/dynamic")) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    // `parseAst` is Vite's bundled oxc parser in plain-JS mode — it does NOT
    // accept JSX or TS syntax. This is correct ONLY because the plugin runs as a
    // normal (non-`enforce`) transform, i.e. AFTER Vite's built-in JSX/TS strip,
    // so `code` here is already plain JS. If this plugin is ever given
    // `enforce: "pre"` it would receive raw `.tsx` source, `parseAst` would
    // throw, and (because we swallow the error below) the feature would silently
    // no-op for every JSX/TS file. Keep it unenforced — see the plugin factory.
    ast = parseAst(code);
  } catch (error) {
    // Distinguish "no dynamic() calls" (the common early return below) from a
    // genuine parse failure. If this fires for valid source, the ordering
    // invariant above has been violated and the feature silently no-ops for
    // every affected file — gate a diagnostic behind DEBUG to surface that
    // without adding noise to normal builds.
    if (typeof process !== "undefined" && process.env?.DEBUG?.includes("vinext")) {
      console.debug(`[vinext] dynamic-preload-metadata: failed to parse ${id}:`, error);
    }
    return null;
  }

  const dynamicLocals = collectDynamicImportLocals(ast);
  if (dynamicLocals.size === 0) return null;

  const output = new MagicString(code);
  let changed = false;
  const pending: Promise<void>[] = [];

  // MagicString edits are safe to issue from out-of-order `.then()` callbacks:
  // every edit addresses ORIGINAL source offsets (not the evolving output) and
  // each `dynamic()` boundary edits a region disjoint from every other (we only
  // append after an argument / inside an options object), so insertion order is
  // irrelevant. Promise ordering is NOT what makes this correct.
  visitDynamicCalls(ast, dynamicLocals, (node) => {
    const args = node.arguments;
    // Match Next.js's react-loadable plugin, which throws on >2 arguments.
    if (args.length > 2) {
      throw new Error(
        `next/dynamic only accepts 2 arguments (${id}${formatNodeLocation(code, node)})`,
      );
    }

    const specifiers = collectImportSpecifiers(dynamicLoaderNode(args[0]));
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
  return magicStringTransformResult(output);
}

export function createDynamicPreloadMetadataPlugin(): Plugin {
  let root = toSlash(process.cwd());

  return {
    name: "vinext:dynamic-preload-metadata",
    // Intentionally NOT `enforce: "pre"`: the transform must run after Vite's
    // built-in JSX/TS stripping so `parseAst` (plain-JS oxc) can parse the code.
    // See the parse note in `transformNextDynamicPreloadMetadata`.
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
          async (specifier, importer) => {
            // Honor the `importer` from ResolveDynamicImport rather than closing
            // over `id`: resolveManifestModuleIds always passes the file being
            // transformed, so this is equivalent today, but matching the
            // declared signature avoids a footgun if that ever changes.
            const resolved = await this.resolve(specifier, importer, { skipSelf: true });
            return resolved?.id ?? null;
          },
        );
        if (!result) return null;
        return result;
      },
    },
  };
}
