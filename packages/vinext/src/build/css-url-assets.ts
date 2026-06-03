import type { Rolldown } from "vite";

/**
 * Next-parity for CSS `url()` asset dependencies.
 *
 * Next.js (webpack `asset/resource`) emits one output file per *source* file a
 * stylesheet references, keyed by module identity. Vite/Rolldown instead dedupe
 * emitted assets by *content*: two byte-identical files (`dark.svg`, `dark2.svg`)
 * collapse to a single output, and every `url()` that referenced either source
 * is rewritten to that one filename — so the second filename disappears.
 *
 * There is no config switch to disable that dedupe (it is intentional; see
 * vitejs/vite#8632). The one native escape hatch is `this.emitFile({ fileName })`:
 * assets emitted with an explicit `fileName` are *never* deduped. So we:
 *
 *   1. mark — during the client CSS transform, tag each relative asset `url()`
 *      with a private `?vinext_css_url_asset=<source-basename>` query. This is
 *      the only durable carrier of per-reference provenance: once Rolldown
 *      dedupes, the emitted bundle cannot tell which `url()` came from which
 *      source, and the bundle metadata (`originalFileNames`) records the set of
 *      sources but not the mapping per reference.
 *
 *   2. restore — at `generateBundle`, read each marked reference's source
 *      basename back out. When it differs from the deduped output's basename,
 *      emit a sibling file under that source's name (via the `fileName` escape
 *      hatch) and rewrite the reference to it. The marker is then stripped.
 *
 * Each reference resolves from its own marker, so split CSS chunks stay correct
 * with no shared cursor or bundle-iteration-order dependence.
 */

const CSS_URL_ASSET_MARKER = "vinext_css_url_asset";

// Stateful `g` regex: callers MUST reset `lastIndex = 0` before each scan.
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/g;
const CSS_ASSET_EXT_RE =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|eot|ttf|otf|mp4|webm|ogg|mp3|wav|flac|aac|wasm)$/i;
const CSS_REQUEST_RE = /\.(?:css|scss|sass|less|styl|stylus)(?:\?|$)/i;

type BundleAsset = Rolldown.OutputAsset;
type CssUrlAssetBundle = Rolldown.OutputBundle;
type EmitRestoredCssUrlAsset = (asset: { fileName: string; source: BundleAsset["source"] }) => void;

// --- small URL/path helpers -------------------------------------------------

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function stem(fileName: string): string {
  const base = basename(fileName);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

type UrlParts = { path: string; query: string; hash: string };

function splitUrl(url: string): UrlParts {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return { path: beforeHash, query: "", hash };
  return { path: beforeHash.slice(0, queryAt), query: beforeHash.slice(queryAt + 1), hash };
}

function joinUrl({ path, query, hash }: UrlParts): string {
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

// We always write the marker value via encodeURIComponent, so it is well-formed
// in practice — but decode defensively so a stray "%" in some other tool's URL
// can never throw mid-bundle and abort the CSS rewrite.
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getMarker(query: string): string | null {
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key === CSS_URL_ASSET_MARKER) {
      return eq === -1 ? "" : decodeURIComponentSafe(part.slice(eq + 1));
    }
  }
  return null;
}

function dropMarker(query: string): string {
  return query
    .split("&")
    .filter(
      (part) =>
        (part.indexOf("=") === -1 ? part : part.slice(0, part.indexOf("="))) !==
        CSS_URL_ASSET_MARKER,
    )
    .join("&");
}

function isRelativeAssetUrl(rawPath: string): boolean {
  // Skip absolute, protocol-relative, root-relative, fragment, data:, and CSS
  // function syntax (parens) — only bundler-resolved relative paths are marked.
  return !(
    rawPath === "" ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("#") ||
    rawPath.includes("(") ||
    /^[a-zA-Z][\w+.-]*:/.test(rawPath)
  );
}

function rewriteUrlToken(match: RegExpExecArray, nextUrl: string): string {
  if (match[1] !== undefined) return `url("${nextUrl}")`;
  if (match[2] !== undefined) return `url('${nextUrl}')`;
  return `url(${nextUrl})`;
}

function isCssRequest(id: string): boolean {
  return CSS_REQUEST_RE.test(id);
}

/** Replace every `url(...)` in `code` whose raw URL `replace()` rewrites. */
function rewriteCssUrls(code: string, replace: (rawUrl: string) => string | null): string | null {
  let out = "";
  let last = 0;
  let changed = false;
  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(code)) !== null) {
    const rawUrl = match[1] ?? match[2] ?? match[3]?.trim();
    if (!rawUrl) continue;
    const next = replace(rawUrl);
    if (next === null) continue;
    out += code.slice(last, match.index) + rewriteUrlToken(match, next);
    last = match.index + match[0].length;
    changed = true;
  }
  return changed ? out + code.slice(last) : null;
}

// --- mark phase -------------------------------------------------------------

/**
 * Append the private provenance marker to each relative asset `url()` in a CSS
 * source. Idempotent and side-effect free (only adds a query param), so it is
 * safe to run on every client-environment stylesheet, vendored CSS included.
 */
export function markCssUrlAssetReferences(code: string, id: string): string | null {
  if (!isCssRequest(id) || !code.includes("url(")) return null;
  return rewriteCssUrls(code, (rawUrl) => {
    const parts = splitUrl(rawUrl.trim());
    if (!isRelativeAssetUrl(parts.path)) return null;
    if (getMarker(parts.query) !== null) return null;
    const lower = parts.path.toLowerCase();
    if (!CSS_ASSET_EXT_RE.test(lower) || lower.endsWith(".css")) return null;
    const param = `${CSS_URL_ASSET_MARKER}=${encodeURIComponent(basename(parts.path))}`;
    return joinUrl({ ...parts, query: parts.query ? `${parts.query}&${param}` : param });
  });
}

// --- restore phase ----------------------------------------------------------

function isCssFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".css");
}

/**
 * Given a deduped output filename (`media/dark.1a2b3c4d.svg`) and the source
 * basename a reference actually wants (`dark2.svg`), produce the sibling output
 * filename (`media/dark2.1a2b3c4d.svg`) by swapping the leading name segment
 * while preserving the hash + extension. `asset.originalFileNames` tells us
 * which source stem the output was named after, so we strip exactly that.
 */
function deriveSiblingFileName(asset: BundleAsset, desiredBasename: string): string {
  const fileName = asset.fileName;
  const slash = fileName.lastIndexOf("/");
  const dir = slash === -1 ? "" : fileName.slice(0, slash + 1);
  const outBase = basename(fileName);
  const desiredStem = stem(desiredBasename);

  const sourceStems = [
    ...(asset.names ?? []),
    asset.name,
    ...(asset.originalFileNames ?? []),
    asset.originalFileName,
  ]
    .filter((n): n is string => !!n)
    .map((n) => stem(n))
    // Longest first so `dark2` is matched before `dark` when both are present.
    .sort((a, b) => b.length - a.length);

  for (const wStem of sourceStems) {
    if (
      wStem &&
      (outBase === wStem || outBase.startsWith(`${wStem}.`) || outBase.startsWith(`${wStem}-`))
    ) {
      return `${dir}${desiredStem}${outBase.slice(wStem.length)}`;
    }
  }
  // Fallback: swap everything up to the first dot (the hash boundary).
  const dot = outBase.indexOf(".");
  return `${dir}${desiredStem}${dot === -1 ? "" : outBase.slice(dot)}`;
}

/**
 * Mutates emitted CSS assets in place so byte-identical `url()` dependencies
 * keep their distinct Next-compatible filenames. Sibling files are produced via
 * `emitRestoredAsset` (which must call `this.emitFile({ type: "asset", fileName,
 * source })` — the explicit `fileName` opts out of Rolldown's content dedupe).
 *
 * Expects CSS to have been marked by `markCssUrlAssetReferences()` first. The
 * marker is stripped from all final output here. CSS that Vite inlined into a JS
 * chunk (`cssCodeSplit: false` / `?inline`) already has final URLs, so chunk
 * code only has the leaked marker stripped — no sibling files are emitted.
 */
export function restoreDedupedCssAssetReferences(
  bundle: CssUrlAssetBundle,
  emitRestoredAsset: EmitRestoredCssUrlAsset,
): void {
  // Index emitted non-CSS assets by output basename so a reference's current
  // (deduped) URL basename resolves back to its asset record. Output basenames
  // embed an 8-char content hash, so a basename collision between two distinct
  // emitted assets would require a hash collision — last-write-wins is safe.
  const assetsByBase = new Map<string, BundleAsset>();
  for (const entry of Object.values(bundle)) {
    if (entry.type === "asset" && !isCssFileName(entry.fileName)) {
      assetsByBase.set(basename(entry.fileName), entry);
    }
  }
  const emitted = new Set(Object.keys(bundle));

  for (const entry of Object.values(bundle)) {
    if (entry.type === "chunk") {
      // Inlined CSS: URLs are already final, just remove the leaked marker.
      if (typeof entry.code === "string" && entry.code.includes(CSS_URL_ASSET_MARKER)) {
        entry.code = stripChunkMarkers(entry.code);
      }
      continue;
    }
    if (!isCssFileName(entry.fileName) || typeof entry.source !== "string") continue;

    entry.source =
      rewriteCssUrls(entry.source, (rawUrl) => {
        const parts = splitUrl(rawUrl);
        const desiredBasename = getMarker(parts.query);
        if (desiredBasename === null) return null;
        const query = dropMarker(parts.query);

        const asset = assetsByBase.get(basename(parts.path));
        if (!asset) return joinUrl({ ...parts, query }); // unknown: just unmark.

        const siblingFileName = deriveSiblingFileName(asset, desiredBasename);
        if (siblingFileName === asset.fileName) {
          return joinUrl({ ...parts, query }); // reference already points at the right file.
        }
        if (!emitted.has(siblingFileName)) {
          emitted.add(siblingFileName);
          emitRestoredAsset({ fileName: siblingFileName, source: asset.source });
        }
        const newPath =
          parts.path.slice(0, parts.path.length - basename(parts.path).length) +
          basename(siblingFileName);
        return joinUrl({ path: newPath, query, hash: parts.hash });
      }) ?? entry.source;
  }
}

// Strips the marker query param from a raw string, agnostic to JS escaping
// (Vite JSON-stringifies inlined CSS, turning `url("…")` into `url(\"…\")`). The
// value is a URL-encoded basename, so it never contains `& # ' " \ )` or
// whitespace. Either drop a leading `?marker=v&` down to `?` (promoting the next
// param), or drop a `?`/`&`-led `marker=v` entirely.
const CSS_URL_MARKER_PARAM_RE = new RegExp(
  `(\\?)${CSS_URL_ASSET_MARKER}=[^&#'")\\\\\\s]*&|[?&]${CSS_URL_ASSET_MARKER}=[^&#'")\\\\\\s]*`,
  "g",
);

function stripChunkMarkers(code: string): string {
  return code.replace(CSS_URL_MARKER_PARAM_RE, (_m, leadingQuestion?: string) =>
    leadingQuestion ? leadingQuestion : "",
  );
}
