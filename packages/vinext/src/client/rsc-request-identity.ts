import type { RscCacheKeyMode } from "../cache/cache-adapters-virtual.js";
import { fnv1a64 } from "../utils/hash.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "../utils/rsc-headers.js";

export const VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM = "_rsc";

const CACHE_BUSTING_DIGEST_BYTES = 12;
const textEncoder = new TextEncoder();
const PREFETCH_RENDER_MODES = new Set([
  "prefetch-empty",
  "prefetch-dynamic-shell",
  "prefetch-loading-shell",
]);

export type CreateRscCacheBustingInputOptions = {
  includeClientReuseManifestHeader?: boolean;
  includePrefetchHeaders?: boolean;
  includeInterceptionIdHeader?: boolean;
  includeRenderModeHeader?: boolean;
  includeStateFingerprintHeader?: boolean;
};

export function getRscCacheKeyMode(): RscCacheKeyMode {
  return process.env.__VINEXT_RSC_CACHE_KEY_MODE === "response-vary"
    ? "response-vary"
    : "header-digest";
}

function normalizeHeaderValue(value: string | null): string {
  return value ?? "0";
}

export function normalizeRscRenderModeHeaderValue(value: string | null): string | null {
  return value !== null && PREFETCH_RENDER_MODES.has(value) ? value : null;
}

export function createRscCacheBustingInput(
  headers: Headers,
  options: CreateRscCacheBustingInputOptions = {},
): string | null {
  // The order of these values determines the hash. Changing it is a breaking
  // cache-key change and requires accepting the previous hash during rollout.
  const values = [
    ...(options.includePrefetchHeaders === false
      ? []
      : [
          headers.get(NEXT_ROUTER_PREFETCH_HEADER),
          headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER),
        ]),
    headers.get(NEXT_ROUTER_STATE_TREE_HEADER),
    headers.get(NEXT_URL_HEADER),
    headers.get(VINEXT_INTERCEPTION_CONTEXT_HEADER),
    ...(options.includeInterceptionIdHeader === false
      ? []
      : [headers.get(VINEXT_INTERCEPTION_ID_HEADER)]),
    headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
    ...(options.includeRenderModeHeader === false
      ? []
      : [normalizeRscRenderModeHeaderValue(headers.get(VINEXT_RSC_RENDER_MODE_HEADER))]),
    ...(options.includeClientReuseManifestHeader === false
      ? []
      : [headers.get(VINEXT_CLIENT_REUSE_MANIFEST_HEADER)]),
  ];
  const stateFingerprint = headers.get(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
  if (options.includeStateFingerprintHeader !== false && stateFingerprint !== null) {
    values.push(stateFingerprint);
  }

  if (values.every((value) => value === null)) {
    return null;
  }

  return values.map(normalizeHeaderValue).join(",");
}

/**
 * Browser-local identity for a navigation-reusable RSC payload. Prefetch-only
 * headers do not change the eventual page payload, while source/router/slot
 * context does and must remain part of the identity.
 */
export function createRscClientCacheVariantKey(headers: Headers): string | null {
  return createRscCacheBustingInput(headers, { includePrefetchHeaders: false });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256RscCacheBustingHash(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // `globalThis.crypto.subtle` is undefined in non-secure browser contexts;
  // fall back to the legacy deterministic hash there.
  if (!subtle) return fnv1a64(input);

  const digest = await subtle.digest("SHA-256", textEncoder.encode(input));
  return encodeBase64Url(new Uint8Array(digest).subarray(0, CACHE_BUSTING_DIGEST_BYTES));
}

export function computeLegacyRscCacheBustingSearchParam(
  headers: Headers,
  options?: CreateRscCacheBustingInputOptions,
): string {
  const input = createRscCacheBustingInput(headers, options);
  return input === null ? "" : fnv1a64(input);
}

async function computeRscCacheBustingSearchParamWithOptions(
  headers: Headers,
  options?: CreateRscCacheBustingInputOptions,
): Promise<string> {
  const input = createRscCacheBustingInput(headers, options);
  return input === null ? "" : sha256RscCacheBustingHash(input);
}

function getSearchPairsWithoutRscCacheBusting(url: URL): string[] {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  return rawQuery
    .split("&")
    .filter((pair) => pair.length > 0 && !isRscCacheBustingSearchPair(pair));
}

function isRscCacheBustingSearchPair(pair: string): boolean {
  const separatorIndex = pair.indexOf("=");
  const rawKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);

  try {
    return (
      decodeURIComponent(rawKey.replaceAll("+", " ")) === VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM
    );
  } catch {
    return rawKey === VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM;
  }
}

/** Detect the internal RSC cache-busting search param with encoded-key support. */
export function hasRscCacheBustingSearchParam(url: URL): boolean {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  return rawQuery.split("&").some((pair) => pair.length > 0 && isRscCacheBustingSearchPair(pair));
}

export async function computeRscCacheBustingSearchParam(headers: Headers): Promise<string> {
  return computeRscCacheBustingSearchParamWithOptions(headers);
}

export function setRscCacheBustingSearchParam(url: URL, hash: string): void {
  const pairs = getSearchPairsWithoutRscCacheBusting(url);
  pairs.push(
    hash.length > 0
      ? `${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}=${hash}`
      : VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  );
  url.search = `?${pairs.join("&")}`;
}

export function stripRscCacheBustingSearchParam(url: URL): void {
  const pairs = getSearchPairsWithoutRscCacheBusting(url);
  url.search = pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

export function stripRscSuffix(pathname: string): string {
  return pathname.replace(/(?:\.|%2[eE])(?:r|%72)(?:s|%73)(?:c|%63)$/, "");
}

function toRscRequestPath(href: string): string {
  const hashIndex = href.indexOf("#");
  return hashIndex === -1 ? href : href.slice(0, hashIndex);
}

/** Create the exact network URL for either digest-keyed or response-Vary RSC requests. */
export async function createRscRequestUrl(
  href: string,
  headers: Headers,
  cacheKeyMode: RscCacheKeyMode = "header-digest",
): Promise<string> {
  const url = new URL(toRscRequestPath(href), "http://vinext.local");
  const hash =
    cacheKeyMode === "response-vary" ? "" : await computeRscCacheBustingSearchParam(headers);
  setRscCacheBustingSearchParam(url, hash);
  return `${url.pathname}${url.search}`;
}

/** Derive the network URL and the stable browser-local cache identity together. */
export async function createRscClientRequestIdentity(
  href: string,
  headers: Headers,
  requestCacheKeyMode: RscCacheKeyMode = "header-digest",
): Promise<{ cacheKeyUrl: string; requestUrl: string }> {
  const requestUrl = await createRscRequestUrl(href, headers, requestCacheKeyMode);
  return {
    cacheKeyUrl:
      requestCacheKeyMode === "header-digest"
        ? requestUrl
        : await createRscRequestUrl(href, headers, "header-digest"),
    requestUrl,
  };
}
