import { fnv1a64 } from "../utils/hash.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  parseAppRscRenderMode,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "./headers.js";

/**
 * RSC cache-busting hashes cover the headers that make an RSC payload vary.
 * Client-side variant headers must survive transit through CDNs and reverse
 * proxies; stripping them changes the server hash and turns stale URLs into
 * repeated canonicalization redirects.
 */
export const VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM = "_rsc";
export const VINEXT_RSC_COMPATIBILITY_ID_HEADER = "X-Vinext-RSC-Compatibility-Id";
export const VINEXT_RSC_CONTENT_TYPE = "text/x-component";

// Re-export so existing consumers that import from this module keep working.
export { VINEXT_RSC_RENDER_MODE_HEADER } from "./headers.js";

export const VINEXT_RSC_VARY_HEADER = [
  RSC_HEADER,
  "Accept",
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
].join(", ");

const CACHE_BUSTING_DIGEST_BYTES = 12;
const textEncoder = new TextEncoder();

type CreateRscRequestHeadersOptions = {
  clientReuseManifestHeader?: string | null;
  interceptionContext?: string | null;
  mountedSlotsHeader?: string | null;
  renderMode?: AppRscRenderMode;
};

type ResolveInvalidRscCacheBustingRequestOptions = {
  isRscRequest: boolean;
  request: Request;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function normalizeHeaderValue(value: string | null): string {
  return value ?? "0";
}

function normalizeCompatibilityId(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function getVinextRscCompatibilityId(): string | null {
  return normalizeCompatibilityId(process.env.__VINEXT_RSC_COMPATIBILITY_ID);
}

export function applyRscCompatibilityIdHeader(
  headers: Headers,
  compatibilityId: string | null | undefined = getVinextRscCompatibilityId(),
): void {
  const normalized = normalizeCompatibilityId(compatibilityId);
  if (normalized) {
    headers.set(VINEXT_RSC_COMPATIBILITY_ID_HEADER, normalized);
  } else {
    headers.delete(VINEXT_RSC_COMPATIBILITY_ID_HEADER);
  }
}

export function isRscCompatibilityIdCompatible(
  responseCompatibilityId: string | null | undefined,
  clientCompatibilityId: string | null | undefined = getVinextRscCompatibilityId(),
): boolean {
  const normalizedResponseCompatibilityId = normalizeCompatibilityId(responseCompatibilityId);
  const normalizedClientCompatibilityId = normalizeCompatibilityId(clientCompatibilityId);
  return (
    normalizedClientCompatibilityId === null ||
    (normalizedResponseCompatibilityId !== null &&
      normalizedResponseCompatibilityId === normalizedClientCompatibilityId)
  );
}

type RscCompatibilityNavigationDecision =
  | { kind: "compatible" }
  | { hardNavigationTarget: string; kind: "hard-navigate" };

export function resolveHardNavigationTargetFromRscResponse(
  responseUrl: string | null | undefined,
  currentHref: string,
  origin: string,
): string {
  if (!responseUrl) {
    return currentHref;
  }

  const parsed = new URL(responseUrl, origin);
  stripRscCacheBustingSearchParam(parsed);
  const origUrl = new URL(currentHref, origin);
  let pathname = stripRscSuffix(parsed.pathname);
  if (origUrl.pathname.length > 1 && origUrl.pathname.endsWith("/") && !pathname.endsWith("/")) {
    pathname += "/";
  }

  let hardNavigationTarget = pathname + parsed.search;
  if (origUrl.hash) hardNavigationTarget += origUrl.hash;
  return hardNavigationTarget;
}

export function resolveRscCompatibilityNavigationDecision(options: {
  clientCompatibilityId?: string | null;
  currentHref: string;
  origin: string;
  responseCompatibilityId: string | null | undefined;
  responseUrl?: string | null;
}): RscCompatibilityNavigationDecision {
  if (
    isRscCompatibilityIdCompatible(options.responseCompatibilityId, options.clientCompatibilityId)
  ) {
    return { kind: "compatible" };
  }

  return {
    hardNavigationTarget: resolveHardNavigationTargetFromRscResponse(
      options.responseUrl,
      options.currentHref,
      options.origin,
    ),
    kind: "hard-navigate",
  };
}

function normalizeRenderModeHeaderValue(value: string | null): string | null {
  const renderMode = parseAppRscRenderMode(value);
  return renderMode === APP_RSC_RENDER_MODE_NAVIGATION ? null : renderMode;
}

type CreateCacheBustingInputOptions = {
  includeRenderModeHeader?: boolean;
};

function createCacheBustingInput(
  headers: Headers,
  options: CreateCacheBustingInputOptions = {},
): string | null {
  // The order of these values determines the hash. Changing it is a breaking
  // cache-key change and requires accepting the previous hash during rollout.
  const values = [
    headers.get(NEXT_ROUTER_PREFETCH_HEADER),
    headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER),
    headers.get(NEXT_ROUTER_STATE_TREE_HEADER),
    headers.get(NEXT_URL_HEADER),
    headers.get(VINEXT_INTERCEPTION_CONTEXT_HEADER),
    headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
    ...(options.includeRenderModeHeader === false
      ? []
      : [normalizeRenderModeHeaderValue(headers.get(VINEXT_RSC_RENDER_MODE_HEADER))]),
  ];

  if (values.every((value) => value === null)) {
    return null;
  }

  return values.map(normalizeHeaderValue).join(",");
}

async function sha256CacheBustingHash(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return encodeBase64Url(new Uint8Array(digest).subarray(0, CACHE_BUSTING_DIGEST_BYTES));
}

function computeLegacyRscCacheBustingSearchParam(headers: Headers): string {
  const input = createCacheBustingInput(headers);
  return input === null ? "" : fnv1a64(input);
}

async function computePreviousRscCacheBustingSearchParam(headers: Headers): Promise<string | null> {
  const input = createCacheBustingInput(headers, { includeRenderModeHeader: false });
  if (input === null) {
    return null;
  }

  return sha256CacheBustingHash(input);
}

function computePreviousLegacyRscCacheBustingSearchParam(headers: Headers): string | null {
  const input = createCacheBustingInput(headers, { includeRenderModeHeader: false });
  return input === null ? null : fnv1a64(input);
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

export async function computeRscCacheBustingSearchParam(headers: Headers): Promise<string> {
  const input = createCacheBustingInput(headers);
  if (input === null) {
    return "";
  }

  return sha256CacheBustingHash(input);
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

/**
 * Remove a trailing `.rsc` suffix from a pathname. Returns the pathname
 * unchanged when the suffix is absent.
 */
export function stripRscSuffix(pathname: string): string {
  return pathname.endsWith(".rsc") ? pathname.slice(0, -4) : pathname;
}

export function createRscRequestHeaders(options: CreateRscRequestHeadersOptions = {}): Headers {
  const headers = new Headers({
    Accept: VINEXT_RSC_CONTENT_TYPE,
    [RSC_HEADER]: "1",
  });

  if (options.interceptionContext !== undefined && options.interceptionContext !== null) {
    headers.set(VINEXT_INTERCEPTION_CONTEXT_HEADER, options.interceptionContext);
  }

  if (options.mountedSlotsHeader !== undefined && options.mountedSlotsHeader !== null) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }

  if (
    options.clientReuseManifestHeader !== undefined &&
    options.clientReuseManifestHeader !== null
  ) {
    headers.set(VINEXT_CLIENT_REUSE_MANIFEST_HEADER, options.clientReuseManifestHeader);
  }

  const renderMode = options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION;
  if (renderMode !== APP_RSC_RENDER_MODE_NAVIGATION) {
    headers.set(VINEXT_RSC_RENDER_MODE_HEADER, renderMode);
  }

  return headers;
}

function toRscRequestPath(href: string): string {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  return beforeHash;
}

export async function createRscRequestUrl(href: string, headers: Headers): Promise<string> {
  const url = new URL(toRscRequestPath(href), "http://vinext.local");
  const hash = await computeRscCacheBustingSearchParam(headers);
  setRscCacheBustingSearchParam(url, hash);
  return `${url.pathname}${url.search}`;
}

export function createServerActionRequestUrl(href: string): string {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const url = new URL(beforeHash, "http://vinext.local");
  return `${url.pathname}${url.search}`;
}

export async function createRscRedirectLocation(
  location: string,
  request: Request,
): Promise<string> {
  const requestUrl = new URL(request.url);
  const destinationUrl = new URL(location, requestUrl);

  if (destinationUrl.origin !== requestUrl.origin) {
    return destinationUrl.toString();
  }

  const rscPath = await createRscRequestUrl(
    `${destinationUrl.pathname}${destinationUrl.search}`,
    request.headers,
  );
  return `${destinationUrl.origin}${rscPath}`;
}

export async function resolveInvalidRscCacheBustingRequest(
  options: ResolveInvalidRscCacheBustingRequestOptions,
): Promise<Response | null> {
  if (
    !options.isRscRequest ||
    (options.request.method !== "GET" && options.request.method !== "HEAD")
  ) {
    return null;
  }

  const url = new URL(options.request.url);
  const actualHash = url.searchParams.get(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM);
  const expectedHash = await computeRscCacheBustingSearchParam(options.request.headers);

  if (actualHash === null && expectedHash === "") {
    return null;
  }

  const acceptedHashes = new Set<string>([expectedHash]);
  if (actualHash !== null && actualHash !== expectedHash) {
    acceptedHashes.add(computeLegacyRscCacheBustingSearchParam(options.request.headers));
    if (
      normalizeRenderModeHeaderValue(options.request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER)) ===
      null
    ) {
      const previousHash = await computePreviousRscCacheBustingSearchParam(options.request.headers);
      const previousLegacyHash = computePreviousLegacyRscCacheBustingSearchParam(
        options.request.headers,
      );
      if (previousHash !== null) acceptedHashes.add(previousHash);
      if (previousLegacyHash !== null) acceptedHashes.add(previousLegacyHash);
    }
  }

  if (actualHash !== null && acceptedHashes.has(actualHash)) {
    return null;
  }

  setRscCacheBustingSearchParam(url, expectedHash);
  return new Response(null, {
    status: 307,
    headers: {
      Location: `${url.pathname}${url.search}`,
    },
  });
}
