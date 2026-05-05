import { fnv1a64 } from "../utils/hash.js";

/**
 * RSC cache-busting hashes cover the headers that make a `.rsc` payload vary.
 * Client-side variant headers must survive transit through CDNs and reverse
 * proxies; stripping them changes the server hash and turns stale URLs into
 * repeated canonicalization redirects.
 */
export const VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM = "_rsc";
export const VINEXT_RSC_CONTENT_TYPE = "text/x-component";
export const VINEXT_RSC_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";

const VINEXT_RSC_HEADER = "RSC";
const VINEXT_RSC_INTERCEPTION_CONTEXT_HEADER = "X-Vinext-Interception-Context";
const NEXT_ROUTER_STATE_TREE_HEADER = "Next-Router-State-Tree";
const NEXT_ROUTER_PREFETCH_HEADER = "Next-Router-Prefetch";
const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = "Next-Router-Segment-Prefetch";
const NEXT_URL_HEADER = "Next-Url";

export const VINEXT_RSC_VARY_HEADER = [
  VINEXT_RSC_HEADER,
  "Accept",
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  VINEXT_RSC_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_RSC_MOUNTED_SLOTS_HEADER,
].join(", ");

const CACHE_BUSTING_DIGEST_BYTES = 12;
const textEncoder = new TextEncoder();

type CreateRscRequestHeadersOptions = {
  interceptionContext?: string | null;
  mountedSlotsHeader?: string | null;
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

function createCacheBustingInput(headers: Headers): string | null {
  // The order of these values determines the hash. Changing it is a breaking
  // cache-key change and requires accepting the previous hash during rollout.
  const values = [
    headers.get(NEXT_ROUTER_PREFETCH_HEADER),
    headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER),
    headers.get(NEXT_ROUTER_STATE_TREE_HEADER),
    headers.get(NEXT_URL_HEADER),
    headers.get(VINEXT_RSC_INTERCEPTION_CONTEXT_HEADER),
    headers.get(VINEXT_RSC_MOUNTED_SLOTS_HEADER),
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
    [VINEXT_RSC_HEADER]: "1",
  });

  if (options.interceptionContext !== undefined && options.interceptionContext !== null) {
    headers.set(VINEXT_RSC_INTERCEPTION_CONTEXT_HEADER, options.interceptionContext);
  }

  if (options.mountedSlotsHeader !== undefined && options.mountedSlotsHeader !== null) {
    headers.set(VINEXT_RSC_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }

  return headers;
}

function toRscRequestPath(href: string): string {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex);
  const normalizedPath =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return `${normalizedPath}.rsc${query}`;
}

export async function createRscRequestUrl(href: string, headers: Headers): Promise<string> {
  const url = new URL(toRscRequestPath(href), "http://vinext.local");
  const hash = await computeRscCacheBustingSearchParam(headers);
  setRscCacheBustingSearchParam(url, hash);
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

  const legacyHash =
    actualHash !== null && actualHash !== expectedHash
      ? computeLegacyRscCacheBustingSearchParam(options.request.headers)
      : null;

  if (actualHash === expectedHash || (legacyHash !== null && actualHash === legacyHash)) {
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
