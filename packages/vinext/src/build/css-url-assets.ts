import type { Rolldown } from "vite";

// Carried through Vite's CSS asset transform and stripped from final CSS.
// Avoid double underscores here because unresolved asset placeholders use them.
const CSS_URL_ASSET_MARKER = "vinext_css_url_asset";
// Module-level and stateful because of the `g` flag: callers MUST reset
// `CSS_URL_RE.lastIndex = 0` before each new scan, otherwise the regex resumes
// from the previous match position and silently skips url() references.
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/g;
const CSS_ASSET_EXT_RE =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|eot|ttf|otf|mp4|webm|ogg|mp3|wav|flac|aac|wasm)$/i;
const CSS_REQUEST_RE = /\.(?:css|scss|sass|less|styl|stylus)$/i;

// Vite/Rolldown dedupes assets by source content. Next.js webpack emits CSS
// url() dependencies as asset/resource modules, so distinct source files keep
// distinct output names even when their bytes are identical.
type BundleAsset = Rolldown.OutputAsset;
type BundleAssetSource = BundleAsset["source"];

type CssUrlAssetBundle = Rolldown.OutputBundle;

type RestoredCssUrlAsset = {
  readonly fileName: string;
  readonly source: BundleAssetSource;
};

type EmitRestoredCssUrlAsset = (asset: RestoredCssUrlAsset) => void;

type UrlParts = {
  readonly path: string;
  readonly query: string;
  readonly hash: string;
};

type AssetIndexes = {
  readonly assetsByFileName: Map<string, BundleAsset>;
  readonly assetsByBaseName: Map<string, BundleAsset[]>;
  readonly restoredFileNames: Map<string, string>;
  readonly usedFileNames: Set<string>;
};

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function basename(value: string): string {
  const normalized = toPosixPath(value);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function fileStem(fileName: string): string {
  const base = basename(fileName);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex <= 0 ? base : base.slice(0, dotIndex);
}

function fileDir(fileName: string): string {
  const normalized = toPosixPath(fileName);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
}

function splitUrl(url: string): UrlParts {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");

  if (queryIndex === -1) {
    return { path: beforeHash, query: "", hash };
  }

  return {
    path: beforeHash.slice(0, queryIndex),
    query: beforeHash.slice(queryIndex + 1),
    hash,
  };
}

function joinUrl({ path, query, hash }: UrlParts): string {
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function queryPartKey(part: string): string {
  const equalsIndex = part.indexOf("=");
  return equalsIndex === -1 ? part : part.slice(0, equalsIndex);
}

function getQueryParam(query: string, name: string): string | null {
  if (!query) return null;

  for (const part of query.split("&")) {
    if (decodeURIComponentSafe(queryPartKey(part)) !== name) continue;
    const equalsIndex = part.indexOf("=");
    return equalsIndex === -1 ? "" : decodeURIComponentSafe(part.slice(equalsIndex + 1));
  }

  return null;
}

function removeQueryParam(query: string, name: string): string {
  if (!query) return "";

  return query
    .split("&")
    .filter((part) => decodeURIComponentSafe(queryPartKey(part)) !== name)
    .join("&");
}

function appendQueryParam(query: string, name: string, value: string): string {
  const param = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  return query ? `${query}&${param}` : param;
}

function isExternalOrRuntimeUrl(pathname: string): boolean {
  return (
    pathname === "" ||
    pathname.startsWith("/") ||
    pathname.startsWith("#") ||
    pathname.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathname) ||
    // Avoid treating CSS function syntax as an asset path in values such as
    // gradient fallbacks. Filenames with parentheses stay on Vite's default path.
    pathname.includes("(")
  );
}

function shouldMarkCssUrlAsset(rawUrl: string): boolean {
  const { path: urlPath, query } = splitUrl(rawUrl.trim());
  if (isExternalOrRuntimeUrl(urlPath)) return false;
  if (getQueryParam(query, CSS_URL_ASSET_MARKER) !== null) return false;

  const lowerPath = urlPath.toLowerCase();
  return CSS_ASSET_EXT_RE.test(lowerPath) && !lowerPath.endsWith(".css");
}

function markCssUrl(rawUrl: string): string | null {
  const trimmedUrl = rawUrl.trim();
  if (!shouldMarkCssUrlAsset(trimmedUrl)) return null;

  const parts = splitUrl(trimmedUrl);
  return joinUrl({
    ...parts,
    query: appendQueryParam(parts.query, CSS_URL_ASSET_MARKER, basename(parts.path)),
  });
}

function isCssRequest(id: string): boolean {
  const queryIndex = id.indexOf("?");
  const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);
  return CSS_REQUEST_RE.test(cleanId);
}

function getCssUrlReplacement(match: RegExpExecArray, nextUrl: string): string {
  if (match[1] !== undefined) return `url("${nextUrl}")`;
  if (match[2] !== undefined) return `url('${nextUrl}')`;
  return `url(${nextUrl})`;
}

// Intentionally runs on every client-environment CSS request, including
// `node_modules` stylesheets. The scope is wider than the upstream Next.js
// fixture exercises, but it is deliberate and safe: marking only appends the
// private provenance query carrying the source basename, it is idempotent (the
// marker check in `shouldMarkCssUrlAsset` bails on already-marked URLs), and the
// restore phase strips the marker before emit — so vendored CSS gets the same
// correct per-source provenance with no behavioral difference. Narrowing this to
// exclude `node_modules` would risk dropping provenance for legitimate vendored
// `url()` assets, so we keep the scope broad.
export function markCssUrlAssetReferences(code: string, id: string): string | null {
  if (!isCssRequest(id) || !code.includes("url(")) return null;

  let markedCode = "";
  let lastIndex = 0;
  let didMark = false;

  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(code)) !== null) {
    const rawUrl = match[1] ?? match[2] ?? match[3]?.trim();
    if (!rawUrl) continue;

    const markedUrl = markCssUrl(rawUrl);
    if (!markedUrl) continue;

    markedCode += code.slice(lastIndex, match.index);
    markedCode += getCssUrlReplacement(match, markedUrl);
    lastIndex = match.index + match[0].length;
    didMark = true;
  }

  if (!didMark) return null;
  return markedCode + code.slice(lastIndex);
}

function getAssetSourceNames(asset: BundleAsset): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  function addName(name: string | undefined): void {
    if (!name) return;
    const sourceName = basename(name);
    if (seen.has(sourceName)) return;
    seen.add(sourceName);
    names.push(sourceName);
  }

  for (const name of asset.names ?? []) addName(name);
  if (asset.name) addName(asset.name);
  for (const originalFileName of asset.originalFileNames ?? []) addName(originalFileName);
  if (asset.originalFileName) addName(asset.originalFileName);

  return names;
}

function isCssFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".css");
}

function outputBaseStartsWithStem(outputBase: string, stem: string): boolean {
  if (!outputBase.startsWith(stem)) return false;
  const nextChar = outputBase[stem.length];
  return nextChar === undefined || nextChar === "." || nextChar === "-";
}

function deriveAssetFileNameForSource(asset: BundleAsset, sourceName: string): string | null {
  const desiredStem = fileStem(sourceName);
  if (!desiredStem) return null;

  const outputDir = fileDir(asset.fileName);
  const outputBase = basename(asset.fileName);
  const sourceNames = getAssetSourceNames(asset).sort(
    (a, b) => fileStem(b).length - fileStem(a).length,
  );

  for (const candidateSourceName of sourceNames) {
    const candidateStem = fileStem(candidateSourceName);
    if (!candidateStem || !outputBaseStartsWithStem(outputBase, candidateStem)) continue;
    return `${outputDir}${desiredStem}${outputBase.slice(candidateStem.length)}`;
  }

  const dotIndex = outputBase.indexOf(".");
  const suffix = dotIndex === -1 ? "" : outputBase.slice(dotIndex);
  return `${outputDir}${desiredStem}${suffix}`;
}

function reserveBundleFileName(fileName: string, usedFileNames: Set<string>): string {
  if (!usedFileNames.has(fileName)) {
    usedFileNames.add(fileName);
    return fileName;
  }

  const dotIndex = fileName.lastIndexOf(".");
  const prefix = dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
  const suffix = dotIndex === -1 ? "" : fileName.slice(dotIndex);

  let index = 1;
  while (true) {
    const candidate = `${prefix}-${index}${suffix}`;
    if (!usedFileNames.has(candidate)) {
      usedFileNames.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function createAssetIndexes(bundle: CssUrlAssetBundle): AssetIndexes {
  const assetsByFileName = new Map<string, BundleAsset>();
  const assetsByBaseName = new Map<string, BundleAsset[]>();

  for (const entry of Object.values(bundle)) {
    if (entry.type !== "asset" || isCssFileName(entry.fileName)) continue;

    assetsByFileName.set(entry.fileName, entry);

    const base = basename(entry.fileName);
    const assets = assetsByBaseName.get(base) ?? [];
    assets.push(entry);
    assetsByBaseName.set(base, assets);
  }

  return {
    assetsByFileName,
    assetsByBaseName,
    restoredFileNames: new Map(),
    usedFileNames: new Set(Object.keys(bundle)),
  };
}

function findAssetForUrlPath(urlPath: string, indexes: AssetIndexes): BundleAsset | null {
  const normalizedPath = toPosixPath(urlPath).replace(/^\/+/, "");
  const directAsset = indexes.assetsByFileName.get(normalizedPath);
  if (directAsset) return directAsset;

  // Vite normally rewrites marked CSS URLs to absolute emitted paths that hit
  // the direct lookup above. These fallbacks keep the marker repair resilient to
  // relative or rebased CSS URL output from future Vite/Rolldown changes.
  for (const [fileName, asset] of indexes.assetsByFileName) {
    if (normalizedPath.endsWith(fileName)) return asset;
  }

  const baseNameMatches = indexes.assetsByBaseName.get(basename(normalizedPath)) ?? [];
  return baseNameMatches.length === 1 ? baseNameMatches[0] : null;
}

function replaceUrlPathAssetFileName(
  urlPath: string,
  currentFileName: string,
  restoredFileName: string,
): string {
  const normalizedPath = toPosixPath(urlPath);
  const pathWithoutLeadingSlash = normalizedPath.replace(/^\/+/, "");

  if (pathWithoutLeadingSlash === currentFileName) {
    return `${normalizedPath.startsWith("/") ? "/" : ""}${restoredFileName}`;
  }

  if (normalizedPath.endsWith(currentFileName)) {
    return (
      normalizedPath.slice(0, normalizedPath.length - currentFileName.length) + restoredFileName
    );
  }

  const currentBaseName = basename(currentFileName);
  if (normalizedPath.endsWith(currentBaseName)) {
    return (
      normalizedPath.slice(0, normalizedPath.length - currentBaseName.length) +
      basename(restoredFileName)
    );
  }

  return urlPath;
}

function assetFileNameMatchesSourceName(fileName: string, sourceName: string): boolean {
  return outputBaseStartsWithStem(basename(fileName), fileStem(sourceName));
}

function ensureAssetFileNameForSource(
  asset: BundleAsset,
  sourceName: string,
  indexes: AssetIndexes,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): string {
  const sourceBaseName = basename(sourceName);
  // Rolldown's deduped asset record does not preserve enough URL provenance to
  // disambiguate same-basename files from different directories. In that case
  // both references intentionally share one restored filename for the same bytes.
  const restoreKey = `${asset.fileName}\0${sourceBaseName}`;
  const cachedFileName = indexes.restoredFileNames.get(restoreKey);
  if (cachedFileName) return cachedFileName;

  if (assetFileNameMatchesSourceName(asset.fileName, sourceBaseName)) {
    indexes.restoredFileNames.set(restoreKey, asset.fileName);
    return asset.fileName;
  }

  const derivedFileName = deriveAssetFileNameForSource(asset, sourceBaseName);
  if (!derivedFileName || derivedFileName === asset.fileName) {
    indexes.restoredFileNames.set(restoreKey, asset.fileName);
    return asset.fileName;
  }

  const existingAsset = indexes.assetsByFileName.get(derivedFileName);
  if (existingAsset?.source === asset.source) {
    indexes.restoredFileNames.set(restoreKey, derivedFileName);
    return derivedFileName;
  }

  const restoredFileName = reserveBundleFileName(derivedFileName, indexes.usedFileNames);
  emitRestoredAsset({ fileName: restoredFileName, source: asset.source });
  indexes.restoredFileNames.set(restoreKey, restoredFileName);
  // Index by the sibling's name but keep the original deduped asset object: we
  // only need its `source` for the byte-identity check above, and the restore
  // cache (`restoredFileNames`) short-circuits before this index is consulted
  // for the sibling. Callers must not assume the indexed asset's `.fileName`
  // matches the key — for this entry it still points at the original.
  indexes.assetsByFileName.set(restoredFileName, asset);

  const base = basename(restoredFileName);
  const assets = indexes.assetsByBaseName.get(base) ?? [];
  assets.push(asset);
  indexes.assetsByBaseName.set(base, assets);

  return restoredFileName;
}

function restoreMarkedCssUrl(
  rawUrl: string,
  indexes: AssetIndexes,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): string | null {
  const parts = splitUrl(rawUrl);
  const sourceName = getQueryParam(parts.query, CSS_URL_ASSET_MARKER);
  if (sourceName === null) return null;

  const queryWithoutMarker = removeQueryParam(parts.query, CSS_URL_ASSET_MARKER);
  const asset = findAssetForUrlPath(parts.path, indexes);
  if (!asset) {
    return joinUrl({ ...parts, query: queryWithoutMarker });
  }

  const restoredFileName = ensureAssetFileNameForSource(
    asset,
    sourceName,
    indexes,
    emitRestoredAsset,
  );

  return joinUrl({
    path: replaceUrlPathAssetFileName(parts.path, asset.fileName, restoredFileName),
    query: queryWithoutMarker,
    hash: parts.hash,
  });
}

function restoreMarkedCssUrls(
  source: string,
  indexes: AssetIndexes,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): string {
  let restoredSource = "";
  let lastIndex = 0;
  let didRestore = false;

  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(source)) !== null) {
    const rawUrl = match[1] ?? match[2] ?? match[3]?.trim();
    if (!rawUrl || !rawUrl.includes(CSS_URL_ASSET_MARKER)) continue;

    const restoredUrl = restoreMarkedCssUrl(rawUrl, indexes, emitRestoredAsset);
    if (!restoredUrl) continue;

    restoredSource += source.slice(lastIndex, match.index);
    restoredSource += getCssUrlReplacement(match, restoredUrl);
    lastIndex = match.index + match[0].length;
    didRestore = true;
  }

  if (!didRestore) return source;
  return restoredSource + source.slice(lastIndex);
}

// Strips the private provenance marker from a url() without restoration. Used
// for CSS that Vite inlined into a JS chunk (`cssCodeSplit: false` or the
// `?inline` query) instead of emitting as a standalone `.css` asset: there the
// asset URL is already final (Vite inlined or rewrote it), so we only need to
// remove the leaked marker query and never emit sibling media files.
function stripMarkedCssUrl(rawUrl: string): string | null {
  const parts = splitUrl(rawUrl);
  if (getQueryParam(parts.query, CSS_URL_ASSET_MARKER) === null) return null;
  return joinUrl({ ...parts, query: removeQueryParam(parts.query, CSS_URL_ASSET_MARKER) });
}

function stripMarkedCssUrls(source: string): string {
  let strippedSource = "";
  let lastIndex = 0;
  let didStrip = false;

  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(source)) !== null) {
    const rawUrl = match[1] ?? match[2] ?? match[3]?.trim();
    if (!rawUrl || !rawUrl.includes(CSS_URL_ASSET_MARKER)) continue;

    const strippedUrl = stripMarkedCssUrl(rawUrl);
    if (!strippedUrl) continue;

    strippedSource += source.slice(lastIndex, match.index);
    strippedSource += getCssUrlReplacement(match, strippedUrl);
    lastIndex = match.index + match[0].length;
    didStrip = true;
  }

  if (!didStrip) return source;
  return strippedSource + source.slice(lastIndex);
}

/**
 * Mutates emitted CSS assets so byte-identical CSS url() dependencies keep
 * Next-compatible source basenames, emitting sibling media files through the
 * callback when Rolldown collapsed multiple source files to one asset.
 *
 * This expects CSS sources to have been passed through
 * `markCssUrlAssetReferences()` before Vite resolves relative asset URLs.
 * The private marker is stripped from final CSS here.
 *
 * CSS that Vite inlined into a JS chunk (`cssCodeSplit: false` or `?inline`)
 * never becomes a standalone `.css` asset, so the restore pass would otherwise
 * leak the private marker into the served CSS string. We defensively strip the
 * marker from chunk code as well (without sibling-emit, since inlined asset URLs
 * are already final).
 */
export function restoreDedupedCssAssetReferences(
  bundle: CssUrlAssetBundle,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): void {
  const indexes = createAssetIndexes(bundle);

  for (const entry of Object.values(bundle)) {
    if (entry.type === "asset") {
      if (!isCssFileName(entry.fileName)) continue;
      if (typeof entry.source !== "string") continue;
      entry.source = restoreMarkedCssUrls(entry.source, indexes, emitRestoredAsset);
      continue;
    }

    // type === "chunk": CSS inlined into JS. Only strip the leaked marker.
    if (typeof entry.code !== "string" || !entry.code.includes(CSS_URL_ASSET_MARKER)) {
      continue;
    }
    entry.code = stripMarkedCssUrls(entry.code);
  }
}
