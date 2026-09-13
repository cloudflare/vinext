import { fnv1a64 } from "../utils/hash.js";
import {
  createAppRscStateFingerprint,
  type AppRscStateFingerprintInput,
} from "./app-rsc-state-fingerprint.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
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
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  NEXTJS_DEPLOYMENT_ID_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "./headers.js";
import { applyDeploymentIdHeader, getDeploymentId } from "../utils/deployment-id.js";

/**
 * RSC cache-busting hashes cover the headers that make an RSC payload vary.
 * Client-side variant headers must survive transit through CDNs and reverse
 * proxies; stripping them changes the server hash and turns stale URLs into
 * repeated canonicalization redirects.
 */
export const VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM = "_rsc";
export const VINEXT_RSC_BUILD_ID_HEADER = "X-Vinext-RSC-Build-Id";
export const VINEXT_RSC_COMPATIBILITY_ID_HEADER = "X-Vinext-RSC-Compatibility-Id";
export const VINEXT_RSC_CONTENT_TYPE = "text/x-component";

// Re-export so existing consumers that import from this module keep working.
export { VINEXT_RSC_RENDER_MODE_HEADER, VINEXT_RSC_VARY_HEADER } from "./headers.js";

const CACHE_BUSTING_DIGEST_BYTES = 12;
const textEncoder = new TextEncoder();

type CreateRscRequestHeadersOptions = {
  clientReuseManifestHeader?: string | null;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  mountedSlotsHeader?: string | null;
  includePrefetchHeader?: boolean;
  renderMode?: AppRscRenderMode;
  fetchPriority?: "auto" | "high" | "low";
  nextUrl?: string | null;
  prefetchRouterState?: {
    pathAndSearch: string;
    routeId: string;
  } | null;
  routerState?: AppRscStateFingerprintInput | null;
  deploymentId?: string | null;
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

function getVinextRscBuildId(): string | null {
  return normalizeCompatibilityId(process.env.__VINEXT_RSC_BUILD_IDENTITY);
}

export function applyRscCompatibilityIdHeader(
  headers: Headers,
  compatibilityId: string | null | undefined = getVinextRscCompatibilityId(),
  buildId: string | null | undefined = getVinextRscBuildId(),
): void {
  const normalized = normalizeCompatibilityId(compatibilityId);
  if (normalized) {
    headers.set(VINEXT_RSC_COMPATIBILITY_ID_HEADER, normalized);
  } else {
    headers.delete(VINEXT_RSC_COMPATIBILITY_ID_HEADER);
  }

  const normalizedBuildId = normalizeCompatibilityId(buildId);
  if (normalizedBuildId) {
    headers.set(VINEXT_RSC_BUILD_ID_HEADER, normalizedBuildId);
  } else {
    headers.delete(VINEXT_RSC_BUILD_ID_HEADER);
  }
}

export function applyRscDeploymentIdHeader(headers: Headers): void {
  const deploymentId = getDeploymentId();
  if (deploymentId) {
    headers.set(NEXTJS_DEPLOYMENT_ID_HEADER, deploymentId);
  } else {
    headers.delete(NEXTJS_DEPLOYMENT_ID_HEADER);
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
  includeInterceptionIdHeader?: boolean;
  includeRenderModeHeader?: boolean;
  includeStateFingerprintHeader?: boolean;
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
    ...(options.includeInterceptionIdHeader === false
      ? []
      : [headers.get(VINEXT_INTERCEPTION_ID_HEADER)]),
    headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
    ...(options.includeRenderModeHeader === false
      ? []
      : [normalizeRenderModeHeaderValue(headers.get(VINEXT_RSC_RENDER_MODE_HEADER))]),
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

async function sha256CacheBustingHash(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // `globalThis.crypto.subtle` is undefined in non-secure browser contexts
  // just fallback to legacy fnv1a64.
  if (!subtle) return fnv1a64(input);

  const digest = await subtle.digest("SHA-256", textEncoder.encode(input));
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

/**
 * Detect the internal RSC cache-busting search param using the same
 * encoding-aware matching as `stripRscCacheBustingSearchParam`
 * (`isRscCacheBustingSearchPair`). The two share a single matcher so a guard
 * built on this helper and the stripper can never disagree on which pairs
 * count as `_rsc`, including encoded-key edge cases like `%5Frsc`.
 */
export function hasRscCacheBustingSearchParam(url: URL): boolean {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  return rawQuery.split("&").some((pair) => pair.length > 0 && isRscCacheBustingSearchPair(pair));
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

export function createCanonicalRscRequestHeaders(
  deploymentId: string | null | undefined = getDeploymentId(),
): Headers {
  const headers = new Headers({
    Accept: VINEXT_RSC_CONTENT_TYPE,
    [RSC_HEADER]: "1",
  });
  applyDeploymentIdHeader(headers, deploymentId ?? undefined);
  return headers;
}

/** Headers for the deterministic loading-boundary prefetch representation. */
export function createCanonicalLoadingShellRscRequestHeaders(
  deploymentId: string | null | undefined = getDeploymentId(),
): Headers {
  const headers = createCanonicalRscRequestHeaders(deploymentId);
  headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
  headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
  headers.set(VINEXT_RSC_RENDER_MODE_HEADER, APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL);
  return headers;
}

export function createRscRequestHeaders(options: CreateRscRequestHeadersOptions = {}): Headers {
  const headers = createCanonicalRscRequestHeaders(options.deploymentId);

  if (options.prefetchRouterState) {
    if (options.includePrefetchHeader !== false) {
      headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
    }
    headers.set(
      NEXT_ROUTER_STATE_TREE_HEADER,
      encodeURIComponent(JSON.stringify(options.prefetchRouterState)),
    );
  }

  const routerState = options.routerState ?? options.prefetchRouterState;
  if (routerState) {
    headers.set(VINEXT_RSC_STATE_FINGERPRINT_HEADER, createAppRscStateFingerprint(routerState));
  }

  if (options.nextUrl) {
    headers.set(NEXT_URL_HEADER, options.nextUrl);
  }

  if (process.env.__NEXT_TEST_MODE && options.fetchPriority) {
    headers.set("Next-Test-Fetch-Priority", options.fetchPriority);
  }

  if (options.interceptionContext !== undefined && options.interceptionContext !== null) {
    headers.set(VINEXT_INTERCEPTION_CONTEXT_HEADER, options.interceptionContext);
  }
  if (options.interceptionId !== undefined && options.interceptionId !== null) {
    headers.set(VINEXT_INTERCEPTION_ID_HEADER, options.interceptionId);
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

/**
 * Convert a full, non-contextual navigation request to the definitive ISR RSC
 * variant. Partial/intercepted/mounted-slot payloads remain contextual because
 * their bytes can legitimately differ from the destination's full route.
 */
export function canonicalizePrewarmableRscRequestHeaders(headers: Headers): boolean {
  if (
    headers.has(VINEXT_RSC_RENDER_MODE_HEADER) ||
    headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER) ||
    headers.has(VINEXT_INTERCEPTION_ID_HEADER) ||
    headers.has(VINEXT_MOUNTED_SLOTS_HEADER)
  ) {
    return false;
  }

  headers.delete(NEXT_ROUTER_PREFETCH_HEADER);
  headers.delete(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
  headers.delete(NEXT_ROUTER_STATE_TREE_HEADER);
  headers.delete(NEXT_URL_HEADER);
  headers.delete(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
  headers.delete(VINEXT_CLIENT_REUSE_MANIFEST_HEADER);
  return true;
}

/**
 * Convert an ordinary loading-boundary prefetch to the shared loading-shell
 * variant. The payload is selected by the three retained mode headers; visible
 * router state is transport context and must not fragment the shared response.
 */
export function canonicalizeLoadingShellRscRequestHeaders(headers: Headers): boolean {
  if (
    headers.get(VINEXT_RSC_RENDER_MODE_HEADER) !== APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL ||
    headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER) ||
    headers.has(VINEXT_INTERCEPTION_ID_HEADER) ||
    headers.has(VINEXT_MOUNTED_SLOTS_HEADER)
  ) {
    return false;
  }

  headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
  headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
  headers.delete(NEXT_ROUTER_STATE_TREE_HEADER);
  headers.delete(NEXT_URL_HEADER);
  headers.delete(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
  headers.delete(VINEXT_CLIENT_REUSE_MANIFEST_HEADER);
  return true;
}

function toRscRequestPath(href: string): string {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  return beforeHash;
}

export async function createRscRequestUrl(href: string, headers: Headers): Promise<string> {
  const url = new URL(toRscRequestPath(href), "http://vinext.local");
  if (
    typeof window !== "undefined" &&
    process.env.NODE_ENV === "production" &&
    process.env.__NEXT_CONFIG_OUTPUT === "export"
  ) {
    // Ported from Next.js:
    // packages/next/src/client/components/router-reducer/fetch-server-response.ts
    // Static hosts cannot select Flight with request headers, so exported App
    // Router navigations address the prebuilt payload directly. The bytes are
    // still RSC; `.txt` supplies a portable MIME type across asset hosts.
    const basePath = process.env.__NEXT_ROUTER_BASEPATH ?? "";
    const isBasePathRoot = basePath !== "" && url.pathname === basePath;
    if (url.pathname.endsWith("/")) {
      url.pathname += "index.txt";
    } else {
      url.pathname += isBasePathRoot ? "/index.txt" : ".txt";
    }
    return `${url.pathname}${url.search}`;
  }
  const hash = await computeRscCacheBustingSearchParam(headers);
  setRscCacheBustingSearchParam(url, hash);
  return `${url.pathname}${url.search}`;
}

/** Build the definitive full-route RSC URL shared by prefetch and navigation. */
export function createCanonicalRscRequestUrl(href: string): string {
  const url = new URL(toRscRequestPath(href), "http://vinext.local");
  setRscCacheBustingSearchParam(url, "");
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

  if (actualHash === null && expectedHash === "" && url.pathname.endsWith(".rsc")) {
    return null;
  }

  const acceptedHashes = new Set<string>([expectedHash]);
  if (actualHash !== null && actualHash !== expectedHash) {
    acceptedHashes.add(computeLegacyRscCacheBustingSearchParam(options.request.headers));
    const compatibilityInputs: CreateCacheBustingInputOptions[] = [];
    const hasInterceptionId = options.request.headers.has(VINEXT_INTERCEPTION_ID_HEADER);
    const hasStateFingerprint = options.request.headers.has(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
    const hasNormalRenderMode =
      normalizeRenderModeHeaderValue(options.request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER)) ===
      null;
    // The interception ID is a positional hash input, so omitting it changes
    // hashes even when the request does not carry the header. Requests from
    // clients predating that positional input remain compatible when the
    // header is absent. Once the header is present, however, only hashes that
    // include its value are safe: Cloudflare's default cache key is URL-based
    // and does not vary on arbitrary headers, while different graph-owned IDs
    // can intentionally select different slot bytes for one source/target.
    if (!hasInterceptionId) {
      compatibilityInputs.push({ includeInterceptionIdHeader: false });
    }
    if (hasStateFingerprint) {
      compatibilityInputs.push({ includeStateFingerprintHeader: false });
      if (!hasInterceptionId) {
        compatibilityInputs.push({
          includeInterceptionIdHeader: false,
          includeStateFingerprintHeader: false,
        });
      }
    }
    if (hasNormalRenderMode) {
      compatibilityInputs.push({ includeRenderModeHeader: false });
      if (!hasInterceptionId) {
        compatibilityInputs.push({
          includeInterceptionIdHeader: false,
          includeRenderModeHeader: false,
        });
      }
    }
    if (hasStateFingerprint && hasNormalRenderMode) {
      compatibilityInputs.push({
        includeRenderModeHeader: false,
        includeStateFingerprintHeader: false,
      });
      if (!hasInterceptionId) {
        compatibilityInputs.push({
          includeInterceptionIdHeader: false,
          includeRenderModeHeader: false,
          includeStateFingerprintHeader: false,
        });
      }
    }
    for (const compatibilityOptions of compatibilityInputs) {
      const input = createCacheBustingInput(options.request.headers, compatibilityOptions);
      if (input === null) {
        acceptedHashes.add("");
      } else {
        acceptedHashes.add(await sha256CacheBustingHash(input));
        acceptedHashes.add(fnv1a64(input));
      }
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
