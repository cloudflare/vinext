/**
 * Server-side variable dynamic import support.
 *
 * Rolldown-Vite's built-in `vite:dynamic-import-vars` plugin only expands
 * variable dynamic imports — `` import(`./${slug}`) `` — for the *client*
 * consumer. In the RSC and SSR (server-consumer) environments it leaves the
 * template literal untouched, so the import resolves to nothing at runtime and
 * the Server Components render throws. This surfaces as a dynamically-imported
 * component rendering the error/fallback boundary instead of its real content.
 *
 * x-ref: https://github.com/cloudflare/vinext/issues/1533
 * Port of Next.js test/e2e/app-dir/dynamic-import (issue vercel/next.js#71840).
 *
 * The fix mirrors what `@rollup/plugin-dynamic-import-vars` does: it scans the
 * importing module's directory for candidate files and rewrites the variable
 * `import()` into a lookup over a generated map of *static* `import()` calls,
 * e.g. `` import(`./${slug}`) `` ->
 *   `{ "./button.tsx": () => import("./button.tsx") }[`./${slug}.tsx`]()`.
 *
 * Emitting fully-static `import("./button.tsx")` specifiers lets the bundler
 * (and `@vitejs/plugin-rsc`'s `"use client"` transform) resolve each candidate
 * to its real chunk — including converting client components into client
 * references — exactly as it does for a hand-written static dynamic import.
 *
 * Only `` import(`...`) `` calls whose static prefix begins with `./` or `../`
 * are rewritten; everything else (bare specifiers, fully static imports, URLs)
 * is left for the built-in plugins to handle unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { parseAstAsync } from "vite";
import MagicString from "magic-string";

class VariableDynamicImportError extends Error {}

function sanitizeString(str: string): string {
  if (str === "") return str;
  if (str.includes("*")) {
    throw new VariableDynamicImportError("A dynamic import cannot contain * characters.");
  }
  return str;
}

type EstreeNode = {
  type: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

function templateLiteralToGlob(node: EstreeNode): string {
  let glob = "";
  for (let i = 0; i < node.quasis.length; i += 1) {
    glob += sanitizeString(node.quasis[i].value.raw);
    if (node.expressions[i]) glob += expressionToGlob(node.expressions[i]);
  }
  return glob;
}

function callExpressionToGlob(node: EstreeNode): string {
  const { callee } = node;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "concat"
  ) {
    return `${expressionToGlob(callee.object)}${node.arguments.map(expressionToGlob).join("")}`;
  }
  return "*";
}

function binaryExpressionToGlob(node: EstreeNode): string {
  if (node.operator !== "+") {
    throw new VariableDynamicImportError(`${node.operator} operator is not supported.`);
  }
  return `${expressionToGlob(node.left)}${expressionToGlob(node.right)}`;
}

function expressionToGlob(node: EstreeNode): string {
  switch (node.type) {
    case "TemplateLiteral":
      return templateLiteralToGlob(node);
    case "CallExpression":
      return callExpressionToGlob(node);
    case "BinaryExpression":
      return binaryExpressionToGlob(node);
    case "Literal":
      return sanitizeString(String(node.value));
    default:
      return "*";
  }
}

type GlobInfo = {
  /** Directory portion before the first `*`, relative to the importer. */
  dirSpec: string;
  /** Whether the dynamic part included a file extension in its static suffix. */
  hasExtension: boolean;
};

/**
 * Convert the import argument expression to glob metadata, or return null when
 * the import is fully static / not analyzable as a directory-scoped glob.
 */
function dynamicImportToGlob(node: EstreeNode): GlobInfo | null {
  let glob = expressionToGlob(node);
  if (!glob.includes("*")) return null;
  glob = glob.replace(/\*\*/g, "*");
  // Only handle directory-relative imports; let the built-in plugins (or the
  // bundler) deal with bare/absolute specifiers.
  if (!glob.startsWith("./") && !glob.startsWith("../")) return null;
  if (/^\.\/\*\.\w+$/.test(glob)) {
    throw new VariableDynamicImportError(
      "Variable imports cannot import their own directory. Place imports in a " +
        "separate directory or make the import filename more specific.",
    );
  }
  // The static prefix is everything before the first `*` (the variable part).
  const starIndex = glob.indexOf("*");
  const prefix = glob.slice(0, starIndex);
  const suffix = glob.slice(starIndex + 1);
  // `import.meta.glob`-style patterns scope to one directory level: take the
  // directory of the static prefix as the candidate directory.
  const dirSpec = prefix.endsWith("/") ? prefix : `${path.posix.dirname(prefix)}/`;
  return { dirSpec, hasExtension: path.posix.extname(suffix) !== "" };
}

const HAS_DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

/**
 * List candidate module files one level deep in `dir`. Returns paths relative
 * to the importer directory, prefixed with `./` (or `../...`) and including the
 * file extension — suitable for a static `import()` specifier.
 */
function listCandidates(importerId: string, importerDir: string, dirSpec: string): string[] {
  const absDir = path.resolve(importerDir, dirSpec);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const importerBase = path.basename(importerId.split("?")[0]);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip the importing module itself to avoid a self-import.
    if (path.resolve(absDir, entry.name) === path.resolve(importerDir, importerBase)) continue;
    const rel = path.posix.normalize(`${dirSpec}${entry.name}`);
    out.push(rel.startsWith(".") ? rel : `./${rel}`);
  }
  return out;
}

/**
 * Create the server-side variable dynamic import plugin.
 *
 * Scoped to the RSC and SSR environments via `applyToEnvironment` so the
 * client build keeps using Vite's built-in (and identical) handling.
 */
export function createServerDynamicImportVarsPlugin(): Plugin {
  let counter = 0;
  return {
    name: "vinext:server-dynamic-import-vars",
    enforce: "post",
    applyToEnvironment(environment) {
      // Only the server consumers (rsc, ssr) need this; the client consumer is
      // handled correctly by Vite's built-in dynamic-import-vars plugin.
      return environment.config.consumer === "server";
    },
    async transform(code, id) {
      if (!HAS_DYNAMIC_IMPORT_RE.test(code)) return null;
      // Skip virtual modules and dependencies — only user source needs this.
      if (id.startsWith("\0") || id.includes("/node_modules/")) return null;

      let ast: { body: EstreeNode[] };
      try {
        ast = (await parseAstAsync(code)) as unknown as { body: EstreeNode[] };
      } catch {
        return null;
      }

      const importerDir = path.dirname(id.split("?")[0]);
      let s: MagicString | undefined;
      const mapDecls: string[] = [];

      const visit = (node: EstreeNode | null | undefined): void => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ImportExpression" && node.source?.type === "TemplateLiteral") {
          const tpl = node.source as EstreeNode;
          // Only handle genuinely-variable templates: a bare `` import(`./x`) ``
          // with no expressions is static and already handled by the bundler.
          if (tpl.expressions.length > 0) {
            let info: GlobInfo | null = null;
            try {
              info = dynamicImportToGlob(tpl);
            } catch {
              info = null;
            }
            if (info) {
              const candidates = listCandidates(id, importerDir, info.dirSpec);
              if (candidates.length > 0) {
                // Build a map of static import() loaders keyed by the candidate
                // specifier, plus a parallel map keyed by the extension-stripped
                // specifier so that `` import(`./${slug}`) `` (no extension)
                // matches `./slug.tsx` the way webpack's context modules do.
                const seen = new Set<string>();
                const entries: string[] = [];
                for (const spec of candidates) {
                  const withoutExt = spec.replace(/\.[^./]+$/, "");
                  for (const key of info.hasExtension ? [spec] : [spec, withoutExt]) {
                    if (seen.has(key)) continue;
                    seen.add(key);
                    entries.push(
                      `  ${JSON.stringify(key)}: () => import(${JSON.stringify(spec)}),`,
                    );
                  }
                }
                const mapName = `__vinextDynImport${counter++}`;
                mapDecls.push(`const ${mapName} = {\n${entries.join("\n")}\n};`);
                // The runtime path expression, e.g. `` `./${slug}` ``.
                const rawPattern = code.slice(tpl.start, tpl.end);
                s ||= new MagicString(code);
                // Replace the whole `import(`...`)` with the map lookup. A
                // missing key throws a descriptive error, matching Vite's
                // built-in dynamic-import-vars helper.
                s.overwrite(
                  node.start,
                  node.end,
                  `(${mapName}[${rawPattern}] ?? (() => { throw new Error("Unknown variable dynamic import: " + (${rawPattern})); }))()`,
                );
              }
            }
          }
        }
        for (const key of Object.keys(node)) {
          if (key === "start" || key === "end" || key === "type") continue;
          const value = node[key];
          if (Array.isArray(value)) {
            for (const child of value) visit(child as EstreeNode);
          } else if (value && typeof value === "object" && typeof value.type === "string") {
            visit(value as EstreeNode);
          }
        }
      };

      for (const node of ast.body) visit(node);

      if (!s || mapDecls.length === 0) return null;
      s.prepend(`${mapDecls.join("\n")}\n`);
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}
