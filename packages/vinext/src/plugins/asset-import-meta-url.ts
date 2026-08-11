import fs from "node:fs";
import path from "pathslash";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import { contentTypeForPath } from "../server/static-file-cache.js";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";
import {
  collectDirectScopeBindings,
  collectLoopScopeBindings,
  collectSwitchScopeBindings,
  collectVarScopeBindings,
  createAstScope,
  hasAstBinding,
  isFunctionNode,
  type AstScope,
} from "./ast-scope.js";
import { OgAssetOwnership } from "./og-asset-ownership.js";

type AssetUrl = {
  range: AstRange;
  sourceRange: AstRange;
  specifier: string;
};

type AssetScope = AstScope & {
  assets: Map<string, AssetUrl>;
};

function createAssetScope(parent: AssetScope | null): AssetScope {
  return { ...createAstScope(parent), assets: new Map() };
}

function importMetaUrlArgument(value: unknown): boolean {
  if (!isAstRecord(value)) return false;
  const expression = value.type === "ChainExpression" ? value.expression : value;
  return (
    isAstRecord(expression) &&
    expression.type === "MemberExpression" &&
    isAstRecord(expression.object) &&
    expression.object.type === "MetaProperty" &&
    isIdentifierNamed(expression.object.meta, "import") &&
    isIdentifierNamed(expression.object.property, "meta") &&
    isIdentifierNamed(expression.property, "url")
  );
}

function assetUrlFromNode(value: unknown): AssetUrl | null {
  if (
    !isAstRecord(value) ||
    value.type !== "NewExpression" ||
    !hasRange(value) ||
    !isIdentifierNamed(value.callee, "URL")
  ) {
    return null;
  }

  const args = nodeArray(value.arguments);
  if (args.length < 2 || !importMetaUrlArgument(args[1])) return null;
  const specifier = args[0];
  if (
    !isAstRecord(specifier) ||
    specifier.type !== "Literal" ||
    typeof specifier.value !== "string"
  ) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier.value) || specifier.value.startsWith("//")) {
    return null;
  }
  return { range: value, sourceRange: value, specifier: specifier.value };
}

function recordAssetBinding(
  declaration: AstRecord,
  declarator: AstRecord,
  scope: AssetScope,
): void {
  if (
    declaration.kind !== "const" ||
    !isAstRecord(declarator.id) ||
    declarator.id.type !== "Identifier" ||
    typeof declarator.id.name !== "string"
  ) {
    return;
  }
  if (hasAstBinding(scope, "URL")) return;
  const asset = assetUrlFromNode(declarator.init);
  if (asset) scope.assets.set(declarator.id.name, asset);
}

function collectAssetScopeBindings(node: AstRecord, scope: AssetScope): void {
  collectDirectScopeBindings(node, scope, (declaration, declarator) =>
    recordAssetBinding(declaration, declarator, scope),
  );
}

function findAssetBinding(scope: AssetScope, name: string): AssetUrl | null {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    const asset = current.assets.get(name);
    if (asset) return asset;
    if (current.bindings.has(name)) return null;
  }
  return null;
}

function createChildScope(node: AstRecord, parent: AssetScope): AssetScope | null {
  if (
    node.type !== "Program" &&
    node.type !== "BlockStatement" &&
    node.type !== "StaticBlock" &&
    node.type !== "TSModuleBlock" &&
    node.type !== "CatchClause" &&
    node.type !== "ForStatement" &&
    node.type !== "ForInStatement" &&
    node.type !== "ForOfStatement" &&
    node.type !== "ClassDeclaration" &&
    node.type !== "ClassExpression"
  ) {
    return null;
  }

  const scope = createAssetScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectAssetScopeBindings(node, scope);
  if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
    collectVarScopeBindings(node, scope);
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    collectLoopScopeBindings(node, scope, (declaration, declarator) =>
      recordAssetBinding(declaration, declarator, scope),
    );
  }
  return scope;
}

function collectAssetUrlRewrites(ast: AstRecord, workerTarget: boolean): AssetUrl[] {
  const assets: AssetUrl[] = [];
  const rootScope = createAssetScope(null);
  collectAssetScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AssetScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAssetScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createAssetScope(parameterScope);
          collectAssetScopeBindings(node.body, bodyScope);
          collectVarScopeBindings(node.body, bodyScope);
          visit(node.body, bodyScope);
        } else {
          visit(node.body, parameterScope);
        }
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
      const switchScope = createAssetScope(parentScope);
      collectSwitchScopeBindings(node, switchScope, (declaration, declarator) =>
        recordAssetBinding(declaration, declarator, switchScope),
      );
      for (const switchCase of nodeArray(node.cases)) {
        if (isAstRecord(switchCase)) visit(switchCase, switchScope);
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;
    const workerAsset = workerTarget && !hasAstBinding(scope, "URL") && assetUrlFromNode(node);
    if (workerAsset) {
      assets.push(workerAsset);
      return;
    }

    if (
      !workerTarget &&
      node.type === "CallExpression" &&
      isIdentifierNamed(node.callee, "fetch") &&
      !hasAstBinding(scope, "fetch")
    ) {
      const input = nodeArray(node.arguments)[0];
      const directAsset = hasAstBinding(scope, "URL") ? null : assetUrlFromNode(input);
      if (directAsset) {
        assets.push(directAsset);
      } else if (
        isAstRecord(input) &&
        input.type === "Identifier" &&
        typeof input.name === "string" &&
        hasRange(input)
      ) {
        const boundAsset = findAssetBinding(scope, input.name);
        if (boundAsset) assets.push({ ...boundAsset, range: input });
      }
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return assets;
}

function parseModule(code: string, id: string): AstRecord | null {
  const extension = path.extname(id.split("?", 1)[0]);
  const lang =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".jsx"
          ? "jsx"
          : "js";
  try {
    const ast = parseAst(code, { lang });
    return isAstRecord(ast) ? ast : null;
  } catch {
    return null;
  }
}

/**
 * Make assets referenced by `new URL("./asset", import.meta.url)` fetchable in
 * server runtimes. Worker bundles replace the URL expression itself because
 * their `import.meta.url` is not a usable base URL. Plain Node bundles replace
 * only the value passed to `fetch()`, preserving file-URL semantics for other
 * consumers such as `fileURLToPath()` and `.pathname`.
 */
export function createAssetImportMetaUrlPlugin(options: { isWorkerTarget: () => boolean }): Plugin {
  const ownership = new OgAssetOwnership();
  const cache = new Map<string, string>();
  let isBuild = false;

  return {
    name: "vinext:asset-import-meta-url",
    enforce: "pre",
    applyToEnvironment(environment) {
      return environment.config.consumer !== "client";
    },
    configResolved(config) {
      isBuild = config.command === "build";
      ownership.configure(config.root, config.resolve.alias);
    },
    buildStart() {
      ownership.reset();
      if (isBuild) cache.clear();
    },
    async resolveId(source, importer, resolveOptions) {
      if (!ownership.shouldTrackImport(source)) return null;
      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      if (resolved === null || resolved.external) return null;
      await ownership.recordResolvedImport(source, resolved.id);
      return null;
    },
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/,
        code: /import\.meta\??\.url/,
      },
      async handler(code, id) {
        if (!/\bnew\s+URL\s*\(/.test(code)) return null;
        const ast = parseModule(code, id);
        if (!ast) return null;
        const rewrites = collectAssetUrlRewrites(ast, options.isWorkerTarget());
        if (rewrites.length === 0) return null;

        const moduleBoundary = await ownership.resolveModuleBoundary(id);
        if (moduleBoundary === null) return null;
        const output = new MagicString(code);
        let changed = false;

        for (const rewrite of rewrites) {
          const argument = nodeArray(rewrite.sourceRange.arguments)[0];
          if (
            isAstRecord(argument) &&
            hasRange(argument) &&
            /\/\*\s*@vite-ignore\s*\*\//.test(code.slice(rewrite.sourceRange.start, argument.start))
          ) {
            continue;
          }

          const cleanSpecifier = rewrite.specifier.split(/[?#]/, 1)[0];
          let file: string | null = null;
          if (cleanSpecifier.startsWith("./") || cleanSpecifier.startsWith("../")) {
            file = await ownership.resolveContainedAsset(
              moduleBoundary.assetRoot,
              path.resolve(moduleBoundary.moduleDir, cleanSpecifier),
            );
          } else {
            const resolved = await this.resolve(rewrite.specifier, id, { skipSelf: true });
            if (resolved !== null && !resolved.external) {
              const assetBoundary = await ownership.resolveModuleBoundary(resolved.id);
              if (assetBoundary !== null) {
                file = await ownership.resolveContainedAsset(
                  assetBoundary.assetRoot,
                  resolved.id.split(/[?#]/, 1)[0],
                );
              }
            }
          }
          if (file === null) continue;

          // The asset is not part of Vite's module graph: its bytes are read
          // directly below and embedded in the transformed module. Register it
          // explicitly so an asset-only edit invalidates the owning module in
          // dev and triggers a rebuild in watch mode.
          this.addWatchFile(file);

          let dataUrl = isBuild ? cache.get(file) : undefined;
          if (dataUrl === undefined) {
            let bytes: Buffer;
            try {
              bytes = await fs.promises.readFile(file);
            } catch {
              continue;
            }
            dataUrl = `data:${contentTypeForPath(file)};base64,${bytes.toString("base64")}`;
            if (isBuild) cache.set(file, dataUrl);
          }

          output.overwrite(
            rewrite.range.start,
            rewrite.range.end,
            `new URL(${JSON.stringify(dataUrl)})`,
          );
          changed = true;
        }

        if (!changed) return null;
        return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
      },
    },
  } satisfies Plugin;
}
