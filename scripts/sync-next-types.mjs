#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const nextPackageJsonPath = require.resolve("next/package.json");
const nextRoot = fs.realpathSync(path.dirname(nextPackageJsonPath));
const nextPackage = JSON.parse(fs.readFileSync(nextPackageJsonPath, "utf-8"));
const publicNextShimMap = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "packages/vinext/src/shims/public-shim-map.json"), "utf-8"),
);

const outputRoot = path.join(repoRoot, "packages/types/next/upstream");
const wrapperPath = path.join(repoRoot, "packages/types/next/next-shims-upstream.generated.d.ts");

const SUPPORTED_UPSTREAM_MODULES = [
  "next",
  ...Object.entries(publicNextShimMap)
    .filter(([, definition]) => definition.types === "upstream")
    .map(([specifier]) => specifier),
];

const PUBLIC_ENTRIES = resolvePublishedPublicEntries();

const EXTRA_ENTRIES = [resolvePublishedDeclaration("next/image-types/global")];

const AMBIENT_NEXT_MODULES = new Set(
  ["types/compiled.d.ts"].flatMap((relativePath) => {
    const source = fs.readFileSync(path.join(nextRoot, relativePath), "utf-8");
    return [...source.matchAll(/\bdeclare module\s+["']([^"']+)["']/g)].map((match) => match[1]);
  }),
);

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function packageFiles() {
  if (!Array.isArray(nextPackage.files)) {
    throw new Error(`next@${nextPackage.version} does not declare a package.json files list`);
  }
  return nextPackage.files.map((entry) => String(entry).replace(/^\.\//, "").replace(/\/$/, ""));
}

function globPattern(entry) {
  let pattern = "^";
  for (let index = 0; index < entry.length; index++) {
    const character = entry[index];
    if (character === "*" && entry[index + 1] === "*") {
      pattern += ".*";
      index++;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else {
      pattern += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function isPublishedPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return packageFiles().some((entry) => {
    if (entry === normalized) return true;
    if (entry.includes("*")) return globPattern(entry).test(normalized);
    return (
      fs.existsSync(path.join(nextRoot, entry)) &&
      fs.statSync(path.join(nextRoot, entry)).isDirectory() &&
      normalized.startsWith(`${entry}/`)
    );
  });
}

function declarationEntryCandidates(moduleName) {
  if (moduleName === "next") {
    const rootTypes = nextPackage.types ?? nextPackage.typings;
    if (typeof rootTypes !== "string") {
      throw new Error(`next@${nextPackage.version} does not declare a package.json types entry`);
    }
    return [rootTypes.replace(/^\.\//, "")];
  }

  const subpath = moduleName.slice("next/".length);
  return [`${subpath}.d.ts`, `${subpath}/index.d.ts`];
}

function resolvePublishedDeclaration(moduleName) {
  const candidates = declarationEntryCandidates(moduleName);
  const source = candidates.find(
    (candidate) => isPublishedPath(candidate) && isFile(path.join(nextRoot, candidate)),
  );
  if (!source) {
    throw new Error(
      `Could not find a published declaration for ${JSON.stringify(moduleName)} in ` +
        `next@${nextPackage.version} package.json (tried ${candidates.join(", ")})`,
    );
  }
  return source;
}

function resolvePublishedPublicEntries() {
  return SUPPORTED_UPSTREAM_MODULES.map((moduleName) => [
    moduleName,
    resolvePublishedDeclaration(moduleName),
  ]);
}

function declarationCandidates(basePath) {
  const withoutJs = basePath.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
  return [
    `${withoutJs}.d.ts`,
    `${basePath}.d.ts`,
    basePath,
    `${basePath}.ts`,
    `${withoutJs}.ts`,
    path.join(basePath, "index.d.ts"),
    path.join(withoutJs, "index.d.ts"),
    path.join(basePath, "index.node.d.ts"),
    path.join(withoutJs, "index.node.d.ts"),
  ];
}

function resolveNextDeclaration(fromPath, specifier) {
  let basePath;
  if (specifier === "next") {
    basePath = path.join(nextRoot, resolvePublishedDeclaration("next"));
  } else if (specifier.startsWith("next/")) {
    basePath = path.join(nextRoot, specifier.slice("next/".length));
  } else if (specifier.startsWith(".")) {
    basePath = path.resolve(path.dirname(fromPath), specifier);
  } else {
    return null;
  }

  return declarationCandidates(basePath).find(isFile) ?? null;
}

function stripComments(source) {
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match, stringLiteral) => stringLiteral ?? match.replace(/[^\r\n]/g, " "),
  );
}

function referencedSpecifiers(source) {
  const references = [];
  const sourceWithoutComments = stripComments(source);
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of sourceWithoutComments.matchAll(pattern)) {
      const specifier = match[1];
      const start = match.index + match[0].lastIndexOf(specifier);
      references.push({ specifier, start, end: start + specifier.length });
    }
  }
  for (const match of source.matchAll(
    /^\s*\/\/\/\s*<reference\s+(?:path|types)=["']([^"']+)["']/gm,
  )) {
    const specifier = match[1];
    const start = match.index + match[0].lastIndexOf(specifier);
    references.push({ specifier, start, end: start + specifier.length });
  }
  return references;
}

function collectDeclarationClosure() {
  const pending = [...PUBLIC_ENTRIES.map(([, source]) => source), ...EXTRA_ENTRIES].map((source) =>
    path.join(nextRoot, source),
  );
  const files = new Set();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || files.has(filePath)) continue;
    if (!isFile(filePath)) {
      throw new Error(`Next.js declaration not found: ${path.relative(nextRoot, filePath)}`);
    }
    files.add(filePath);

    const source = fs.readFileSync(filePath, "utf-8");
    for (const { specifier } of referencedSpecifiers(source)) {
      const resolved = resolveNextDeclaration(filePath, specifier);
      if (resolved) pending.push(resolved);
      else if (AMBIENT_NEXT_MODULES.has(specifier)) continue;
      else if (specifier.startsWith("next/") || specifier.startsWith(".")) {
        throw new Error(
          `Could not resolve ${JSON.stringify(specifier)} from ${path.relative(nextRoot, filePath)}`,
        );
      }
    }
  }

  return [...files].sort((a, b) => a.localeCompare(b));
}

function withoutDeclarationExtension(filePath) {
  return filePath.replace(/\.d\.(?:mts|cts|ts)$/, "").replace(/\.(?:mts|cts|ts)$/, "");
}

function relativeDeclarationSpecifier(fromRelativePath, targetPath) {
  const targetRelativePath = path.relative(nextRoot, targetPath).split(path.sep).join("/");
  let specifier = path.posix.relative(
    path.posix.dirname(fromRelativePath),
    withoutDeclarationExtension(targetRelativePath),
  );
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function rewriteNextSpecifiers(source, absolutePath, relativePath) {
  const replacements = [];
  for (const { specifier, start, end } of referencedSpecifiers(source)) {
    if (specifier !== "next" && !specifier.startsWith("next/")) continue;
    const target = resolveNextDeclaration(absolutePath, specifier);
    if (!target && AMBIENT_NEXT_MODULES.has(specifier)) continue;
    if (!target) {
      throw new Error(`Could not rewrite ${JSON.stringify(specifier)} from ${relativePath}`);
    }
    replacements.push({ start, end, value: relativeDeclarationSpecifier(relativePath, target) });
  }

  let rewritten = source;
  for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, start) + value + rewritten.slice(end);
  }
  return rewritten;
}

function renderVendoredFiles() {
  const files = new Map();
  for (const absolutePath of collectDeclarationClosure()) {
    const relativePath = path.relative(nextRoot, absolutePath).split(path.sep).join("/");
    const source = fs.readFileSync(absolutePath, "utf-8");
    const header = `// Generated by scripts/sync-next-types.mjs from next@${nextPackage.version}: ${relativePath}\n// @generated\n`;
    let rewritten = rewriteNextSpecifiers(source, absolutePath, relativePath);
    rewritten = rewritten.replace(/[ \t]+(?=\r?$)/gm, "");
    if (relativePath === "dist/compiled/webpack/webpack.d.ts") {
      rewritten = rewritten.replace(
        /\n}\s*$/,
        "\n  export type RuleSetUseItem = any\n" +
          "  export type LoaderDefinitionFunction<T = any> = any\n" +
          "}\n\n" +
          "export type LoaderDefinitionFunction<T = any> = any\n",
      );
    }
    if (relativePath === "dist/build/webpack/loaders/next-app-loader/index.d.ts") {
      rewritten = rewritten.replace(
        /import type webpack from (['"][^'"]+['"]);/,
        "import type { webpack } from $1;",
      );
    }
    if (
      relativePath === "dist/styled-jsx/types/css.d.ts" ||
      relativePath === "dist/styled-jsx/types/macro.d.ts"
    ) {
      rewritten = rewritten.replace(/\bexport\s*=\s*(\w+)/g, "export default $1");
    }
    files.set(relativePath, header + rewritten);
  }
  files.set("LICENSE.next.md", fs.readFileSync(path.join(nextRoot, "license.md"), "utf-8"));
  return files;
}

function upstreamSpecifier(source) {
  return `@vinext/types/next/upstream/${withoutDeclarationExtension(source)}`;
}

function hasDefaultExport(sourcePath) {
  const source = stripComments(fs.readFileSync(path.join(nextRoot, sourcePath), "utf-8"));
  return (
    /\bexport\s+default\b/.test(source) ||
    /\bexport\s*\{[^}]*\bdefault\s*(?:,|\})/.test(source) ||
    /\bexport\s*\{[^}]*\bas\s+default\s*(?:,|\})/.test(source)
  );
}

function renderWrappers() {
  const lines = [
    `// Generated by scripts/sync-next-types.mjs from next@${nextPackage.version}`,
    "// @generated",
  ];

  for (const [moduleName, source] of PUBLIC_ENTRIES) {
    const target =
      moduleName === "next/router" ? "@vinext/types/next/vinext/router" : upstreamSpecifier(source);
    lines.push(`declare module ${JSON.stringify(moduleName)} {`);
    if (moduleName === "next") {
      lines.push(`  export type * from ${JSON.stringify(target)};`);
      lines.push("}", "");
      continue;
    }
    lines.push(`  export * from ${JSON.stringify(target)};`);
    if (hasDefaultExport(source)) {
      lines.push(`  export { default } from ${JSON.stringify(target)};`);
    }
    lines.push("}", "");
  }

  return lines.join("\n");
}

function listFiles(root, prefix = "") {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function checkGeneratedFiles(expectedFiles, expectedWrapper) {
  const actualFiles = listFiles(outputRoot);
  const expectedPaths = [...expectedFiles.keys()].sort((a, b) => a.localeCompare(b));
  const problems = [];

  if (actualFiles.join("\n") !== expectedPaths.join("\n")) {
    problems.push("the vendored declaration file list differs");
  }
  for (const [relativePath, expected] of expectedFiles) {
    const filePath = path.join(outputRoot, relativePath);
    if (!isFile(filePath) || fs.readFileSync(filePath, "utf-8") !== expected) {
      problems.push(relativePath);
    }
  }
  if (!isFile(wrapperPath) || fs.readFileSync(wrapperPath, "utf-8") !== expectedWrapper) {
    problems.push(path.relative(repoRoot, wrapperPath));
  }

  if (problems.length > 0) {
    throw new Error(
      `Next.js type snapshot is out of date (${problems.slice(0, 10).join(", ")}). ` +
        "Run `pnpm run sync:next-types`.",
    );
  }
}

function writeGeneratedFiles(files, wrapper) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const filePath = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  fs.writeFileSync(wrapperPath, wrapper);
}

function main() {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== "--check");
  if (unknownArgs.length > 0) throw new Error(`Unknown arguments: ${unknownArgs.join(", ")}`);

  const files = renderVendoredFiles();
  const wrapper = renderWrappers();
  if (args.includes("--check")) {
    checkGeneratedFiles(files, wrapper);
    console.log(
      `Next.js types are in sync with next@${nextPackage.version} (${files.size - 1} files)`,
    );
  } else {
    writeGeneratedFiles(files, wrapper);
    console.log(`Synced Next.js types from next@${nextPackage.version} (${files.size - 1} files)`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
