import {
  ASSET_PREFIX_URL_DIR,
  isAbsoluteAssetPrefix,
  resolveAssetsDir,
  resolveAssetUrlPrefix,
} from "./asset-prefix.js";

function normalizeManifestFile(file: string): string {
  return file.startsWith("/") ? file.slice(1) : file;
}

export function manifestFileWithBase(file: string, base: string): string {
  const normalizedFile = normalizeManifestFile(file);
  if (!base || base === "/") return normalizedFile;

  // Vite's SSR manifest stores base-prefixed paths without a leading slash,
  // e.g. "docs/assets/app.js" for base "/docs/".
  const normalizedBase = normalizeManifestFile(base).replace(/\/+$/, "");
  if (!normalizedBase) return normalizedFile;
  if (normalizedFile.startsWith(normalizedBase + "/")) return normalizedFile;
  return normalizedBase + "/" + normalizedFile;
}

export function manifestFileWithAssetPrefix(
  file: string,
  base: string,
  assetPrefix: string,
): string {
  if (!assetPrefix) return manifestFileWithBase(file, base);

  const normalizedFile = normalizeManifestFile(file);
  const onDiskDir = normalizeManifestFile(resolveAssetsDir(assetPrefix));
  const onDiskDirPrefix = onDiskDir + "/";
  const staticDirPrefix = ASSET_PREFIX_URL_DIR + "/";
  const stripped = normalizedFile.startsWith(onDiskDirPrefix)
    ? normalizedFile.slice(onDiskDirPrefix.length)
    : normalizedFile.startsWith(staticDirPrefix)
      ? normalizedFile.slice(staticDirPrefix.length)
      : normalizedFile;

  const urlPrefix = resolveAssetUrlPrefix(assetPrefix);
  const normalizedUrlPrefix = isAbsoluteAssetPrefix(assetPrefix)
    ? urlPrefix
    : normalizeManifestFile(urlPrefix);
  return normalizedUrlPrefix + stripped;
}

function stripBasePathSegment(file: string, basePath: string): string {
  const normalizedBase = normalizeManifestFile(basePath).replace(/\/+$/, "");
  if (!normalizedBase) return file;
  return file.startsWith(normalizedBase + "/") ? file.slice(normalizedBase.length + 1) : file;
}

/**
 * Resolve the URL a client asset is actually SERVED from, starting from a
 * base-anchored manifest / SSR-manifest value (no leading slash), e.g.
 * `"docs/cdn/_next/static/x.js"`.
 *
 * Next.js semantics: `assetPrefix` REPLACES `basePath` for asset URLs (they do
 * not stack). So when an `assetPrefix` is configured we strip the basePath
 * segment and re-anchor under the assetPrefix — matching how `next/dynamic`
 * preloads are computed (`manifestFileWithAssetPrefix`) and what the prod server
 * / Cloudflare ASSETS binding actually serve. Without this, a `basePath` +
 * path-style `assetPrefix` build emits `/<basePath>/<assetPrefix>/_next/...`
 * which 404s. When no `assetPrefix` is set, the base-anchored value is already
 * the served URL and is returned unchanged (just root-anchored).
 *
 * Returns an absolute URL for an absolute `assetPrefix`, otherwise a
 * root-relative URL beginning with `/`.
 */
export function assetServingUrlFromBaseAnchored(
  value: string,
  basePath: string,
  assetPrefix: string,
): string {
  const normalized = normalizeManifestFile(value);
  if (!assetPrefix) return "/" + normalized;

  const onDiskRelative = stripBasePathSegment(normalized, basePath);
  // `base` is unused by manifestFileWithAssetPrefix when assetPrefix is set.
  const anchored = manifestFileWithAssetPrefix(onDiskRelative, "/", assetPrefix);
  return isAbsoluteAssetPrefix(assetPrefix) ? anchored : "/" + anchored;
}

/**
 * Strip a `base` prefix that Vite applied twice: it bakes `base` into the
 * on-disk chunk fileName and then prepends it again in `ssr-manifest.json`,
 * yielding `docs/docs/_next/static/...` which 404s. Only an exact
 * `<base>/<base>/` prefix is collapsed; a single prefix is left untouched.
 */
export function collapseDuplicateBase(file: string, base: string): string {
  const normalizedFile = normalizeManifestFile(file);
  if (!base || base === "/") return normalizedFile;

  const normalizedBase = normalizeManifestFile(base).replace(/\/+$/, "");
  if (!normalizedBase) return normalizedFile;

  const doubledPrefix = `${normalizedBase}/${normalizedBase}/`;
  return normalizedFile.startsWith(doubledPrefix)
    ? normalizedFile.slice(normalizedBase.length + 1)
    : normalizedFile;
}

// Chunks every Pages Router document loads: the `framework` and `vinext`
// manualChunks groups (see createClientManualChunks) plus the client entry.
const SHARED_CHUNK_NAMES = new Set(["framework", "vinext"]);
const SHARED_ENTRY_CHUNK_MARKERS = ["vinext-client-entry", "vinext-app-browser-entry"];

/**
 * Whether a Rolldown chunk belongs to the shared Pages Router runtime, judged
 * by its chunk name (or entry facade module id) rather than its emitted file
 * name so user-configured or hash-only `chunkFileNames` keep their
 * modulepreload/script tags.
 */
export function isSharedClientChunkName(
  name: string | undefined,
  facadeModuleId?: string | null,
): boolean {
  if (name && SHARED_CHUNK_NAMES.has(name)) return true;
  return SHARED_ENTRY_CHUNK_MARKERS.some(
    (marker) => name?.includes(marker) || facadeModuleId?.includes(marker),
  );
}

/**
 * Reserved `ssr-manifest.json` key listing the shared runtime chunk files.
 * Consumers that pass the on-disk manifest straight to `renderPage()` (the
 * legacy two-call Pages build) have no registered build metadata, and file
 * names alone can't identify these chunks. The `\0` prefix keeps it from
 * matching any module id.
 */
export const SSR_MANIFEST_SHARED_CHUNKS_KEY = "\0vinext:shared-chunks";
