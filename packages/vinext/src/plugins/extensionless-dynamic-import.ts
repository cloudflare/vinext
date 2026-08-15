import MagicString from "magic-string";
import fs from "node:fs";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { parseAst, type Alias, type Plugin } from "vite";
import {
  DYNAMIC_IMPORT_PRESCAN,
  forEachAstChild,
  hasRange,
  isAstRecord,
  nodeArray,
  type AstRecord,
} from "./ast-utils.js";
import { createTransformCache } from "./transform-cache.js";
import { isUnknownRecord } from "../utils/record.js";
import { escapeRegExp } from "../utils/regex.js";

const MODULE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const TRANSFORMABLE_EXTENSIONS = new Set([
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".cjs",
  ".cts",
]);

type ExtensionlessImport = {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
} & (
  | {
      kind: "relative";
      globPattern: string | readonly string[];
      moduleExtensions: readonly string[];
    }
  | {
      kind: "package";
      resolution: PackageImportResolution;
    }
);

type PackageImportResolution = {
  globPattern: string | readonly string[];
  packageName: string;
  requestPrefix: string;
  requestSuffix: string;
  resolvedPrefix: string;
  resolvedSuffix: string;
};

type PackageJson = {
  name?: unknown;
  exports?: unknown;
};

type TransformConfig = {
  aliases: readonly Alias[];
  moduleExtensions: readonly string[];
  exportConditions: ReadonlySet<string>;
};

type TransformEnvironmentConfig = {
  isProduction?: boolean;
  resolve: {
    alias?: readonly Alias[];
    conditions?: readonly string[];
    extensions: readonly string[];
  };
};

export function createExtensionlessDynamicImportPlugin(): Plugin {
  let transformConfig: TransformConfig = {
    aliases: [],
    moduleExtensions: MODULE_EXTENSIONS,
    exportConditions: new Set(["import", "module", "node", "development", "default"]),
  };
  const environmentConfigs = new WeakMap<object, TransformConfig>();
  // Keyed by the config object reference: configResolved replaces the object
  // wholesale, so results computed under previous extensions or conditions
  // never leak forward.
  const cached = createTransformCache<TransformConfig, TransformResult>();

  return {
    name: "vinext:extensionless-dynamic-import",
    enforce: "pre",
    configResolved(config) {
      transformConfig = createTransformConfig(config);
    },
    transform: {
      filter: {
        id: {
          include: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i,
          exclude: /[\\/]node_modules[\\/]/,
        },
        code: DYNAMIC_IMPORT_PRESCAN,
      },
      handler(code, id) {
        const environmentConfig = this.environment?.config as
          | TransformEnvironmentConfig
          | undefined;
        let activeConfig = transformConfig;
        if (environmentConfig) {
          activeConfig =
            environmentConfigs.get(environmentConfig) ?? createTransformConfig(environmentConfig);
          environmentConfigs.set(environmentConfig, activeConfig);
        }
        return cached(id, code, activeConfig, () =>
          transformExtensionlessImports(code, id, activeConfig),
        );
      },
    },
  };
}

type TransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
} | null;

function transformExtensionlessImports(
  code: string,
  id: string,
  config: TransformConfig,
): TransformResult {
  const lang = langForId(id)!;

  let ast: unknown;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

  const imports = collectExtensionlessImports(ast, code, config, id);
  if (imports.length === 0) return null;

  const output = new MagicString(code);
  for (const dynamicImport of imports) {
    const source = code.slice(dynamicImport.sourceStart, dynamicImport.sourceEnd);
    output.overwrite(
      dynamicImport.start,
      dynamicImport.end,
      dynamicImport.kind === "package"
        ? buildPackageReplacement(source, dynamicImport.resolution)
        : buildReplacement(source, dynamicImport.globPattern, dynamicImport.moduleExtensions),
    );
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

function langForId(id: string): "js" | "jsx" | "ts" | "tsx" | null {
  const clean = id.split("?", 1)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot).toLowerCase();
  if (!TRANSFORMABLE_EXTENSIONS.has(ext)) return null;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".tsx") return "tsx";
  return "jsx";
}

function collectExtensionlessImports(
  ast: unknown,
  code: string,
  config: TransformConfig,
  id: string,
): ExtensionlessImport[] {
  const imports: ExtensionlessImport[] = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;
    const parsed = parseExtensionlessImport(value, code, config, id);
    if (parsed) {
      imports.push(parsed);
      return;
    }
    forEachAstChild(value, visit);
  }

  visit(ast);
  return imports;
}

function parseExtensionlessImport(
  node: AstRecord,
  code: string,
  config: TransformConfig,
  id: string,
): ExtensionlessImport | null {
  if (node.type !== "ImportExpression" || !hasRange(node)) return null;
  if (node.options != null) return null;
  const source = node.source;
  if (!isAstRecord(source) || source.type !== "TemplateLiteral" || !hasRange(source)) return null;
  if (nodeArray(source.expressions).length === 0) return null;

  const quasis = nodeArray(source.quasis);
  const quasiTexts = quasis.map(templateElementText);
  if (quasiTexts.some((text) => text == null)) return null;
  const texts = quasiTexts as string[];
  const first = texts[0];
  if (!isImportPrefix(code.slice(node.start, source.start))) return null;
  if (texts.some((text) => /[*?[\]{}()!?#]/.test(text))) return null;
  if (!(first.startsWith("./") || first.startsWith("../"))) {
    const resolution = resolvePackageImport(
      first,
      texts,
      id,
      config.exportConditions,
      config.aliases,
    );
    return resolution
      ? {
          kind: "package",
          start: node.start,
          end: node.end,
          sourceStart: source.start,
          sourceEnd: source.end,
          resolution,
        }
      : null;
  }
  if (texts.slice(1).some((text) => text.includes("."))) return null;

  const directoryEnd = first.lastIndexOf("/") + 1;
  const directory = first.slice(0, directoryEnd);
  const filenamePrefix = first.slice(directoryEnd);
  if (filenamePrefix.includes(".")) return null;

  return {
    kind: "relative",
    start: node.start,
    end: node.end,
    sourceStart: source.start,
    sourceEnd: source.end,
    globPattern: filenamePrefix.length > 0 ? [`${first}*`, `${first}*/**/*`] : `${directory}**/*`,
    moduleExtensions: config.moduleExtensions,
  };
}

function resolvePackageImport(
  first: string,
  texts: readonly string[],
  id: string,
  exportConditions: ReadonlySet<string>,
  aliases: readonly Alias[],
): PackageImportResolution | null {
  const packageName = parsePackageName(first);
  if (packageName === null || first === packageName || !first.startsWith(`${packageName}/`)) {
    return null;
  }
  // Rewriting to the physical package would bypass Vite's configured alias.
  // Leave any template that may intersect an alias to the normal resolver.
  const requestSpecifierPattern = [first, ...texts.slice(1)].join("*");
  if (aliasesMayMatch(aliases, requestSpecifierPattern)) return null;

  const packageInfo = resolvePackageInfo(packageName, id);
  if (packageInfo === null || !isUnknownRecord(packageInfo.packageJson.exports)) return null;

  const requestPattern = `./${[first.slice(packageName.length + 1), ...texts.slice(1)].join("*")}`;
  const matchedExport = findBestPackageExport(packageInfo.packageJson.exports, requestPattern);
  if (matchedExport === null) return null;

  const { keyMatch, exportValue } = matchedExport;
  for (const target of resolveExportTargets(exportValue, exportConditions)) {
    if (!target.startsWith("./")) continue;
    const targetParts = decodePackageTarget(target);
    if (targetParts === null) continue;

    const [targetPrefix, targetSuffix] = targetParts;
    const decodedCapture = decodeRequestCapturePattern(keyMatch.capture);
    if (decodedCapture === null) continue;
    const absoluteGlob = path.resolve(
      packageInfo.packageRoot,
      `${targetPrefix.slice(2)}${decodedCapture}${targetSuffix}`,
    );
    const absolutePrefix = path.resolve(packageInfo.packageRoot, targetPrefix.slice(2));
    if (
      !isWithinPackage(packageInfo.packageRoot, absoluteGlob) ||
      !isWithinPackage(packageInfo.packageRoot, absolutePrefix)
    ) {
      continue;
    }

    const importerDirectory = resolveImporterDirectory(id);
    const globPath = toImporterPath(importerDirectory, absoluteGlob);
    const resolvedPrefixPath = toImporterPath(importerDirectory, absolutePrefix);
    if (globPath === null || resolvedPrefixPath === null) return null;
    const resolvedPrefix =
      resolvedPrefixPath.replace(/\/+$/, "") + (targetPrefix.endsWith("/") ? "/" : "");
    const globPattern = buildPackageGlobPatterns(resolvedPrefix, decodedCapture, targetSuffix);
    if (globPattern === null) return null;
    return {
      globPattern,
      packageName,
      requestPrefix: `${packageName}/${keyMatch.prefix.slice(2)}`,
      requestSuffix: keyMatch.suffix,
      resolvedPrefix,
      resolvedSuffix: targetSuffix,
    };
  }

  return null;
}

function findBestPackageExport(
  exports: Record<string, unknown>,
  requestPattern: string,
): { keyMatch: WildcardMatch; exportValue: unknown } | null {
  let best: { exportKey: string; keyMatch: WildcardMatch; exportValue: unknown } | null = null;
  for (const [exportKey, exportValue] of Object.entries(exports)) {
    const keyMatch = matchWildcardPattern(exportKey, requestPattern);
    if (keyMatch === null) continue;
    if (best === null || comparePatternKeys(exportKey, best.exportKey) < 0) {
      best = { exportKey, keyMatch, exportValue };
    }
  }
  if (
    best === null ||
    hasHigherPrecedenceExportIntersection(exports, requestPattern, best.exportKey)
  ) {
    return null;
  }
  return { keyMatch: best.keyMatch, exportValue: best.exportValue };
}

function hasHigherPrecedenceExportIntersection(
  exports: Record<string, unknown>,
  requestPattern: string,
  selectedKey: string,
): boolean {
  for (const exportKey of Object.keys(exports)) {
    if (exportKey === selectedKey || exportKey === ".") continue;
    if (!exportKey.includes("*")) {
      if (matchesTemplatePattern(requestPattern, exportKey)) return true;
      continue;
    }
    if (
      comparePatternKeys(exportKey, selectedKey) < 0 &&
      wildcardPatternsMayIntersect(requestPattern, exportKey)
    ) {
      return true;
    }
  }
  return false;
}

function matchesTemplatePattern(templatePattern: string, value: string): boolean {
  const source = templatePattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(value);
}

function wildcardPatternsMayIntersect(left: string, right: string): boolean {
  const leftBounds = wildcardPatternBounds(left);
  const rightBounds = wildcardPatternBounds(right);
  return (
    (leftBounds.prefix.startsWith(rightBounds.prefix) ||
      rightBounds.prefix.startsWith(leftBounds.prefix)) &&
    (leftBounds.suffix.endsWith(rightBounds.suffix) ||
      rightBounds.suffix.endsWith(leftBounds.suffix))
  );
}

function wildcardPatternBounds(pattern: string): { prefix: string; suffix: string } {
  const firstWildcard = pattern.indexOf("*");
  const lastWildcard = pattern.lastIndexOf("*");
  return {
    prefix: pattern.slice(0, firstWildcard),
    suffix: pattern.slice(lastWildcard + 1),
  };
}

// Matches Node's package exports pattern precedence: the longest base wins,
// then the longest complete key. Object insertion order is not significant.
function comparePatternKeys(left: string, right: string): number {
  const leftBaseLength = left.indexOf("*") + 1;
  const rightBaseLength = right.indexOf("*") + 1;
  return rightBaseLength - leftBaseLength || right.length - left.length;
}

function parsePackageName(specifierPrefix: string): string | null {
  const segments = specifierPrefix.split("/");
  if (specifierPrefix.startsWith("@")) {
    return segments.length >= 2 && segments[0] && segments[1]
      ? `${segments[0]}/${segments[1]}`
      : null;
  }
  return segments[0] || null;
}

function aliasesMayMatch(aliases: readonly Alias[], requestPattern: string): boolean {
  const requestPrefix = requestPattern.slice(0, requestPattern.indexOf("*"));
  return aliases.some((alias) => {
    const { find } = alias;
    // Arbitrary regular-expression/template intersection is not decidable.
    if (find instanceof RegExp) return !isViteInternalAlias(alias);
    if (matchesTemplatePattern(requestPattern, find)) return true;
    const aliasPrefix = `${find}/`;
    return requestPrefix.startsWith(aliasPrefix) || aliasPrefix.startsWith(requestPrefix);
  });
}

function isViteInternalAlias(alias: Alias): boolean {
  if (!(alias.find instanceof RegExp)) return false;
  const replacement = toSlash(alias.replacement);
  const source =
    replacement.endsWith("/vite/client/env.mjs") ||
    replacement.endsWith("/vite/dist/client/env.mjs")
      ? "@vite/env"
      : replacement.endsWith("/vite/client/client.mjs") ||
          replacement.endsWith("/vite/dist/client/client.mjs")
        ? "@vite/client"
        : null;
  if (source === null) return false;
  alias.find.lastIndex = 0;
  const matches = alias.find.test(source);
  alias.find.lastIndex = 0;
  return matches;
}

function decodePackageTarget(target: string): [prefix: string, suffix: string] | null {
  // Raw URL query/fragment delimiters are not filesystem characters in Node's
  // package-target URL resolution. Their percent-encoded forms remain valid.
  if (target.includes("?") || target.includes("#")) return null;
  const targetParts = splitSingleWildcard(target);
  if (targetParts === null) return null;
  const [rawPrefix, rawSuffix] = targetParts;
  // A percent escape can span the wildcard boundary. Supporting that would
  // require a runtime-derived glob, so preserve the native import instead.
  if (/%[\da-f]?$/i.test(rawPrefix) || /^[\da-f]/i.test(rawSuffix)) return null;
  for (const segment of target.slice(2).split("/")) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decodedSegment === "." ||
      decodedSegment === ".." ||
      decodedSegment.toLowerCase() === "node_modules" ||
      decodedSegment.includes("/") ||
      decodedSegment.includes("\\")
    ) {
      return null;
    }
  }
  const wildcard = target.indexOf("*");
  try {
    return [
      decodeURIComponent(target.slice(0, wildcard)),
      decodeURIComponent(target.slice(wildcard + 1)),
    ];
  } catch {
    return null;
  }
}

function decodeRequestCapturePattern(pattern: string): string | null {
  const parts = pattern.split("*");
  for (let index = 0; index < parts.length - 1; index++) {
    if (/%[\da-f]?$/i.test(parts[index]) || /^[\da-f]/i.test(parts[index + 1])) return null;
  }

  const decodedParts: string[] = [];
  for (const part of parts) {
    const decodedSegments: string[] = [];
    for (const segment of part.split("/")) {
      let decodedSegment: string;
      try {
        decodedSegment = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (decodedSegment.includes("/") || decodedSegment.includes("\\")) return null;
      decodedSegments.push(decodedSegment);
    }
    decodedParts.push(decodedSegments.join("/"));
  }
  return decodedParts.join("*");
}

function resolvePackageInfo(
  packageName: string,
  id: string,
): { packageRoot: string; packageJson: PackageJson } | null {
  const cleanId = id.split(/[?#]/, 1)[0];
  const selfPackage = findNearestPackageInfo(path.dirname(cleanId), packageName);
  if (selfPackage !== null) return selfPackage;

  let resolver: NodeRequire;
  try {
    resolver = createRequire(cleanId);
  } catch {
    return null;
  }

  try {
    const entry = resolver.resolve(packageName);
    const fromEntry = findPackageInfo(path.dirname(entry), packageName);
    if (fromEntry !== null) return fromEntry;
  } catch {
    // Packages with only subpath exports do not have a resolvable root entry.
  }

  for (const lookupPath of resolver.resolve.paths(packageName) ?? []) {
    const candidate = path.join(lookupPath, packageName, "package.json");
    const packageJson = readPackageJson(candidate);
    if (packageJson?.name === packageName) {
      return { packageRoot: path.dirname(candidate), packageJson };
    }
  }

  return null;
}

function findNearestPackageInfo(
  startDirectory: string,
  packageName: string,
): { packageRoot: string; packageJson: PackageJson } | null {
  let directory = startDirectory;
  while (true) {
    const filename = path.join(directory, "package.json");
    if (fs.existsSync(filename)) {
      const packageJson = readPackageJson(filename);
      return packageJson?.name === packageName ? { packageRoot: directory, packageJson } : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function findPackageInfo(
  startDirectory: string,
  packageName: string,
): { packageRoot: string; packageJson: PackageJson } | null {
  let directory = startDirectory;
  while (true) {
    const packageJson = readPackageJson(path.join(directory, "package.json"));
    if (packageJson?.name === packageName) {
      return { packageRoot: directory, packageJson };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readPackageJson(filename: string): PackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function resolveExportTargets(value: unknown, conditions: ReadonlySet<string>): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    // A valid first array target wins in Node even if vinext cannot express it
    // as a glob. Never skip ahead to a later target with different semantics.
    return value.length === 0 ? [] : resolveExportTargets(value[0], conditions);
  }
  if (!isUnknownRecord(value)) return [];

  // Package export conditions are ordered from most specific to least
  // specific, so select the first branch active in this Vite environment.
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "default" || conditions.has(condition)) {
      return resolveExportTargets(target, conditions);
    }
  }
  return [];
}

type WildcardMatch = { prefix: string; suffix: string; capture: string };

function matchWildcardPattern(pattern: string, value: string): WildcardMatch | null {
  const parts = splitSingleWildcard(pattern);
  if (parts === null) return null;
  const [prefix, suffix] = parts;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return {
    prefix,
    suffix,
    capture: value.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length),
  };
}

function splitSingleWildcard(value: string): [prefix: string, suffix: string] | null {
  const wildcard = value.indexOf("*");
  if (wildcard < 0 || wildcard !== value.lastIndexOf("*")) return null;
  return [value.slice(0, wildcard), value.slice(wildcard + 1)];
}

function isWithinPackage(packageRoot: string, target: string): boolean {
  const relative = path.relative(packageRoot, target);
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

function toImporterPath(importerDirectory: string, absolutePath: string): string | null {
  const relative = path.relative(importerDirectory, absolutePath);
  // Vite glob keys must be relative to the importer. There is no valid
  // relative specifier between Windows drives, so leave that import untouched.
  if (path.isAbsolute(relative)) return null;
  return relative.startsWith(".") ? relative : `./${relative}`;
}

const POSIX_UNESCAPED_GLOB_SYMBOLS = /(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\()|\\(?![()[\]{}!*+?@|]))/g;
const WIN32_UNESCAPED_GLOB_SYMBOLS = /(?<!\\)([()[\]{}]|^!|[!+@](?=\())/g;

function escapeGlobLiteral(value: string): string {
  const pattern =
    process.platform === "win32" ? WIN32_UNESCAPED_GLOB_SYMBOLS : POSIX_UNESCAPED_GLOB_SYMBOLS;
  return value.replace(pattern, "\\$&");
}

function buildPackageGlobPatterns(
  resolvedPrefix: string,
  capturePattern: string,
  resolvedSuffix: string,
): string | readonly string[] | null {
  const parts = capturePattern.split("*");
  const wildcardCount = parts.length - 1;
  // Each expression needs both a segment-local and a slash-crossing variant.
  // Keep expansion bounded; unusually complex templates remain native imports.
  if (wildcardCount === 0 || wildcardCount > 4) return null;

  let captures = [escapeGlobLiteral(parts[0])];
  for (let index = 0; index < wildcardCount; index++) {
    const suffix = escapeGlobLiteral(parts[index + 1]);
    captures = captures.flatMap((capture) => [`${capture}*${suffix}`, `${capture}*/**/*${suffix}`]);
  }

  const prefix = escapeGlobLiteral(resolvedPrefix);
  const suffix = escapeGlobLiteral(resolvedSuffix);
  const patterns = [
    ...new Set(captures.map((capture) => `${prefix}${capture}${suffix}`)),
    `!${prefix}**/node_modules/**`,
  ];
  return patterns.length === 1 ? patterns[0] : patterns;
}

function resolveImporterDirectory(id: string): string {
  const directory = path.dirname(id.split(/[?#]/, 1)[0]);
  try {
    return toSlash(fs.realpathSync.native(directory));
  } catch {
    return directory;
  }
}

function isImportPrefix(value: string): boolean {
  const prefix = value.match(/^import\s*\(/)?.[0];
  if (!prefix) return false;

  let index = prefix.length;
  while (index < value.length) {
    const char = value[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (value.startsWith("/*", index)) {
      const commentEnd = value.indexOf("*/", index + 2);
      if (commentEnd < 0) return false;
      index = commentEnd + 2;
      continue;
    }

    if (value.startsWith("//", index)) {
      const lineEnd = value.indexOf("\n", index + 2);
      if (lineEnd < 0) return true;
      index = lineEnd + 1;
      continue;
    }

    return false;
  }

  return true;
}

function templateElementText(value: unknown): string | null {
  if (!isAstRecord(value) || value.type !== "TemplateElement") return null;
  const templateValue = value.value;
  if (typeof templateValue !== "object" || templateValue === null) return null;
  const cooked = Reflect.get(templateValue, "cooked");
  return typeof cooked === "string" ? cooked : null;
}

function getModuleExtensions(config: TransformEnvironmentConfig): string[] {
  return config.resolve.extensions.filter((extension) => extension !== ".node");
}

function getExportConditions(config: TransformEnvironmentConfig): ReadonlySet<string> {
  const productionCondition = config.isProduction ? "production" : "development";
  const conditions = new Set(["import", "default", productionCondition]);
  for (const condition of config.resolve.conditions ?? []) {
    conditions.add(condition === "development|production" ? productionCondition : condition);
  }
  return conditions;
}

function createTransformConfig(config: TransformEnvironmentConfig): TransformConfig {
  return {
    aliases: config.resolve.alias ?? [],
    moduleExtensions: getModuleExtensions(config),
    exportConditions: getExportConditions(config),
  };
}

const JAVASCRIPT_STRING_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function serializeJavaScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/g,
    (character) => JAVASCRIPT_STRING_ESCAPE_MAP[character],
  );
}

function buildReplacement(
  source: string,
  globPattern: string | readonly string[],
  moduleExtensions: readonly string[],
): string {
  const extensions = serializeJavaScriptValue(moduleExtensions);
  return `((__vinextPath, __vinextModules = import.meta.glob(${serializeJavaScriptValue(globPattern)}), __vinextExtensions = ${extensions}) => { const __vinextLoader = __vinextModules[__vinextPath] ?? __vinextExtensions.map((__vinextExtension) => __vinextModules[__vinextPath + __vinextExtension]).find(Boolean) ?? __vinextExtensions.map((__vinextExtension) => __vinextModules[__vinextPath + "/index" + __vinextExtension]).find(Boolean); return __vinextLoader ? __vinextLoader() : Promise.reject(new Error("Cannot find module '" + __vinextPath + "'")); })(${source})`;
}

function buildPackageReplacement(source: string, resolution: PackageImportResolution): string {
  const captureEnd = resolution.requestSuffix
    ? `-${serializeJavaScriptValue(resolution.requestSuffix)}.length`
    : "undefined";
  const packageSubpathStart = resolution.packageName.length + 1;
  return `((__vinextPath, __vinextModules = import.meta.glob(${serializeJavaScriptValue(resolution.globPattern)}, { exhaustive: true })) => { const __vinextSegments = __vinextPath.slice(${packageSubpathStart}).split("/"); let __vinextDecodedSegments, __vinextCapture; try { __vinextDecodedSegments = __vinextSegments.map((__vinextSegment) => decodeURIComponent(__vinextSegment)); __vinextCapture = __vinextPath.slice(${serializeJavaScriptValue(resolution.requestPrefix)}.length, ${captureEnd}).split("/").map((__vinextSegment) => decodeURIComponent(__vinextSegment)).join("/"); } catch { return Promise.reject(new Error("Cannot find module '" + __vinextPath + "'")); } const __vinextInvalidSubpath = __vinextPath.includes("?") || __vinextPath.includes("#") || __vinextDecodedSegments.some((__vinextSegment) => __vinextSegment === "." || __vinextSegment === ".." || __vinextSegment.toLowerCase() === "node_modules" || __vinextSegment.includes("/") || __vinextSegment.includes("\\\\")); if (__vinextInvalidSubpath) return Promise.reject(new Error("Cannot find module '" + __vinextPath + "'")); const __vinextResolvedPath = (${serializeJavaScriptValue(resolution.resolvedPrefix)} + __vinextCapture + ${serializeJavaScriptValue(resolution.resolvedSuffix)}).replace(/\\/+/g, "/"); const __vinextLoader = __vinextModules[__vinextResolvedPath]; return __vinextLoader ? __vinextLoader() : Promise.reject(new Error("Cannot find module '" + __vinextPath + "'")); })(${source})`;
}
