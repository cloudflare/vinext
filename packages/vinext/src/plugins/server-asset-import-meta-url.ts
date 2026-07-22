/**
 * vinext:server-asset-import-meta-url
 *
 * Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
 * `client` environment (it gates on `environment.config.consumer === "client"`).
 * That means `new URL('./style.css', import.meta.url)` references in
 * server-side code (Pages Router API routes, edge runtime handlers,
 * server components) are left untransformed in the SSR bundle, with two
 * consequences:
 *
 *   1. The referenced asset file is never emitted alongside the SSR
 *      bundle, so the resolved URL points at a path that does not exist
 *      on disk.
 *   2. At runtime, `import.meta.url` resolves relative to the emitted
 *      SSR JS, so `new URL('./style.css', import.meta.url)` yields a
 *      `file://` URL under `dist/server/style.css` — and `import(...)`
 *      of that URL crashes with `ERR_MODULE_NOT_FOUND`.
 *
 * This reproduces the Next.js deploy-suite failure described in
 * cloudflare/vinext#1346, mirroring the
 * `test/e2e/react-version/pages/api/pages-api-edge-url-dep.js` fixture
 * which does `import(new URL('./style.css', import.meta.url).href)` from
 * an edge API route purely to validate that URL dependencies don't break
 * the build.
 *
 * Approach:
 *   - In `transform` (non-client environments only) we emit each
 *     referenced asset via `this.emitFile`, then rewrite the original
 *     `new URL("./X", import.meta.url)` to use a vinext-internal
 *     placeholder containing the reference id.
 *   - Cloudflare builds instead inline the asset as a `data:` URL because
 *     workerd exposes `import.meta.url` as the non-URL string `"worker"`.
 *     This keeps URL construction valid; the code consuming that URL still
 *     determines whether the referenced asset type is supported at runtime.
 *   - In `renderChunk` we resolve the placeholder to a relative URL from
 *     the host chunk to the emitted asset (e.g. `./_next/static/<hash>.css`).
 *     A relative URL is required because in SSR/server builds Vite's
 *     default `toOutputFilePathInJS` returns the root-absolute URL
 *     (`/_next/static/...`), which `new URL(..., import.meta.url)` would
 *     resolve to `file:///_next/static/...` at Node runtime — outside
 *     the build output directory.
 *
 * Skipped when the user adds a `/* @vite-ignore *\/` comment, matching
 * Vite's upstream behaviour.
 */

import { parseAst, type Plugin } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import fs from "node:fs";
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

const VITE_IGNORE_RE = /\/\*\s*@vite-ignore\s*\*\//;

// Placeholder that survives Vite's renderChunk pipeline (it does not start
// with `__VITE_ASSET__`, so Vite's own asset resolver leaves it alone) and
// is resolved by this plugin's own renderChunk hook.
const PLACEHOLDER_PREFIX = "__VINEXT_SERVER_ASSET__";
const PLACEHOLDER_SUFFIX = "__";
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_PREFIX}([\\w$-]+)${PLACEHOLDER_SUFFIX}`, "g");

const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

function assetDataUrl(file: string, buffer: Buffer): string {
  const mimeType = ASSET_MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

type AssetUrlExpression = {
  node: AstRange;
  pathname: string;
  suffix: string;
};

function splitAssetUrl(url: string): { pathname: string; suffix: string } {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const suffixIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  if (suffixIndex === -1) return { pathname: url, suffix: "" };
  return { pathname: url.slice(0, suffixIndex), suffix: url.slice(suffixIndex) };
}

function parserLanguage(id: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = path.extname(id.split("?", 1)[0]).toLowerCase();
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  return "js";
}

function stringLiteralValue(value: unknown): string | null {
  if (!isAstRecord(value)) return null;
  if (
    (value.type === "Literal" || value.type === "StringLiteral") &&
    typeof value.value === "string"
  ) {
    return value.value;
  }
  if (value.type === "TemplateLiteral" && nodeArray(value.expressions).length === 0) {
    const quasi = nodeArray(value.quasis)[0];
    if (isAstRecord(quasi) && typeof quasi.value === "object" && quasi.value !== null) {
      const cooked = Reflect.get(quasi.value, "cooked");
      const raw = Reflect.get(quasi.value, "raw");
      if (typeof cooked === "string") return cooked;
      if (typeof raw === "string") return raw;
    }
  }
  return null;
}

function isImportMetaUrl(value: unknown): boolean {
  if (!isAstRecord(value) || value.type !== "MemberExpression" || value.computed === true) {
    return false;
  }
  const object = isAstRecord(value.object) ? value.object : null;
  return (
    object?.type === "MetaProperty" &&
    isIdentifierNamed(object.meta, "import") &&
    isIdentifierNamed(object.property, "meta") &&
    isIdentifierNamed(value.property, "url")
  );
}

function createChildScope(node: AstRecord, parent: AstScope): AstScope | null {
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

  const scope = createAstScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectDirectScopeBindings(node, scope);
  if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
    collectVarScopeBindings(node, scope);
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    collectLoopScopeBindings(node, scope);
  }
  return scope;
}

function collectAssetUrlExpressions(code: string, id: string): AssetUrlExpression[] {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: parserLanguage(id) });
  } catch {
    return [];
  }

  if (!isAstRecord(ast)) return [];

  const expressions: AssetUrlExpression[] = [];
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AstScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createAstScope(parameterScope);
          collectDirectScopeBindings(node.body, bodyScope);
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
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        if (isAstRecord(switchCase)) visit(switchCase, switchScope);
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;
    if (
      node.type === "NewExpression" &&
      isIdentifierNamed(node.callee, "URL") &&
      !hasAstBinding(scope, "URL") &&
      hasRange(node)
    ) {
      const args = nodeArray(node.arguments);
      const url = stringLiteralValue(args[0]);
      const firstArgument = isAstRecord(args[0]) ? args[0] : null;
      if (
        args.length === 2 &&
        url !== null &&
        (url.startsWith("./") || url.startsWith("../")) &&
        isImportMetaUrl(args[1]) &&
        hasRange(firstArgument) &&
        !VITE_IGNORE_RE.test(code.slice(node.start, firstArgument.start))
      ) {
        expressions.push({ node, ...splitAssetUrl(url) });
      }
    }
    forEachAstChild(node, (child) => visit(child, scope));
  }
  for (const node of nodeArray(ast.body)) {
    if (isAstRecord(node)) visit(node, rootScope);
  }
  return expressions;
}

/**
 * Create the `vinext:server-asset-import-meta-url` Vite plugin.
 *
 * Emits assets referenced via `new URL("./path", import.meta.url)` in
 * server environments and rewrites the URL to point at the emitted file.
 * Node/self-hosted SSR uses an emitted file with a chunk-relative URL.
 * Cloudflare builds use an inline `data:` URL so URL construction remains
 * valid in workerd, where `import.meta.url` is not a file URL.
 *
 * The more specific OG asset plugin runs first. If it declines an arbitrary
 * user `fetch(new URL(...))`, this plugin deliberately handles the remaining
 * `new URL(...)` as a normal server asset reference.
 */
export function createServerAssetImportMetaUrlPlugin(
  isCloudflareBuild: () => boolean = () => false,
): Plugin {
  return {
    name: "vinext:server-asset-import-meta-url",
    enforce: "pre",
    apply: "build",
    // Run for non-client build environments. Vite's upstream plugin already
    // covers `client`. The caller supplies vinext's already-resolved
    // Cloudflare plugin detection so transform() can select a workerd-safe
    // data URL instead of a Node filesystem-relative URL.
    applyToEnvironment(environment) {
      return environment.config.consumer !== "client";
    },
    transform: {
      filter: { code: "import.meta.url" },
      async handler(code, id) {
        // Skip virtual modules — `id` would not be a real file system path
        // and resolving the relative URL against it would be meaningless.
        if (id.startsWith("\0") || id.startsWith("virtual:")) return null;

        const moduleDir = path.dirname(id.split("?")[0]!);
        const output = new MagicString(code);
        let didReplace = false;

        for (const { node, pathname, suffix } of collectAssetUrlExpressions(code, id)) {
          const file = path.resolve(moduleDir, pathname);
          let buffer: Buffer;
          try {
            buffer = await fs.promises.readFile(file);
          } catch {
            // File does not exist on disk — likely a runtime-generated
            // path or the developer expects the asset to be present
            // elsewhere. Leave the expression alone.
            continue;
          }

          if (isCloudflareBuild()) {
            output.overwrite(
              node.start,
              node.end,
              // Do not append the original query/fragment to a data URL.
              // A query becomes part of the base64 payload for data: fetches
              // and makes the inlined asset unreadable. The file bytes are
              // already content-addressed inside the generated URL.
              `new URL(${JSON.stringify(assetDataUrl(file, buffer))})`,
            );
            didReplace = true;
            continue;
          }

          const referenceId = this.emitFile({
            type: "asset",
            name: path.basename(file),
            source: buffer,
          });

          // Replace the entire `new URL("./X", import.meta.url)` expression
          // with a plugin-private placeholder wrapped in `new URL(...,
          // import.meta.url)`. The placeholder is resolved in renderChunk
          // (below) to a chunk-relative URL so the runtime computes the
          // correct file:// URL at module load time.
          output.overwrite(
            node.start,
            node.end,
            `new URL(${JSON.stringify(
              `${PLACEHOLDER_PREFIX}${referenceId}${PLACEHOLDER_SUFFIX}${suffix}`,
            )}, import.meta.url)`,
          );
          didReplace = true;
        }

        if (!didReplace) return null;
        return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
      },
    },
    renderChunk(code, chunk) {
      if (!code.includes(PLACEHOLDER_PREFIX)) return null;
      const re = new RegExp(PLACEHOLDER_RE);
      let match: RegExpExecArray | null;
      let result = "";
      let lastIndex = 0;
      let didReplace = false;

      // Compute a POSIX-style chunk-relative URL to each emitted asset so
      // `new URL(<placeholder>, import.meta.url)` resolves to the real
      // file at Node runtime. Vite's default for SSR returns a root-
      // absolute path (`/_next/static/...`), which would resolve to
      // `file:///_next/...` and crash.
      const chunkDir = path.posix.dirname(chunk.fileName);
      const toRelative = (assetFileName: string) => {
        let rel = path.posix.relative(chunkDir, assetFileName);
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel;
      };

      while ((match = re.exec(code))) {
        const fullMatch = match[0];
        const referenceId = match[1]!;
        let assetFileName: string;
        try {
          assetFileName = this.getFileName(referenceId);
        } catch {
          continue;
        }
        const replacement = toRelative(assetFileName);
        if (match.index > lastIndex) {
          result += code.slice(lastIndex, match.index);
        }
        // Re-encode as a JS string literal — we are substituting inside
        // a `JSON.stringify`-emitted literal in the original source.
        result += JSON.stringify(replacement).slice(1, -1);
        lastIndex = match.index + fullMatch.length;
        didReplace = true;
      }

      if (!didReplace) return null;
      if (lastIndex < code.length) {
        result += code.slice(lastIndex);
      }
      return { code: result, map: null };
    },
  } satisfies Plugin;
}
