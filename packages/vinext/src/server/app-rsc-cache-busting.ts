import {
  type CreateRscCacheBustingInputOptions,
  computeLegacyRscCacheBustingSearchParam,
  computeRscCacheBustingSearchParam,
  createRscCacheBustingInput,
  createRscRequestUrl,
  getRscCacheKeyMode,
  hasRscCacheBustingSearchParam,
  normalizeRscRenderModeHeaderValue,
  setRscCacheBustingSearchParam,
  sha256RscCacheBustingHash,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
} from "../client/rsc-request-identity.js";
import {
  createAppRscStateFingerprint,
  type AppRscStateFingerprintInput,
} from "./app-rsc-state-fingerprint.js";
import { APP_RSC_RENDER_MODE_NAVIGATION, type AppRscRenderMode } from "./app-rsc-render-mode.js";
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
import type { RscCacheKeyMode } from "../cache/cache-adapters-virtual.js";
import {
  isCanonicalSharedRscRequestHeaders,
  isServerRscPrewarmEligiblePathname,
  resolveResponseVaryRscCacheBustingRequest,
} from "vinext/shims/rsc-prewarm-server";

/**
 * RSC cache-busting hashes cover the headers that make an RSC payload vary.
 * Client-side variant headers must survive transit through CDNs and reverse
 * proxies; stripping them changes the server hash and turns stale URLs into
 * repeated canonicalization redirects.
 */
export const VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER = "X-Vinext-RSC-Cache-Busting-Redirect";
export const VINEXT_RSC_COMPATIBILITY_ID_HEADER = "X-Vinext-RSC-Compatibility-Id";
export const VINEXT_RSC_CONTENT_TYPE = "text/x-component";

// Re-export so existing consumers that import from this module keep working.
export { VINEXT_RSC_RENDER_MODE_HEADER } from "./headers.js";
export {
  computeRscCacheBustingSearchParam,
  createRscClientCacheVariantKey,
  createRscRequestUrl,
  getRscCacheKeyMode,
  hasRscCacheBustingSearchParam,
  setRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
} from "../client/rsc-request-identity.js";

const VINEXT_APP_BASE_VARY_HEADERS = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
] as const;

/** App response identity for requests without active interception context. */
export const VINEXT_APP_NON_CONTEXTUAL_VARY_HEADER = VINEXT_APP_BASE_VARY_HEADERS.join(", ");

/** App response identity for requests whose interception context can affect the payload. */
export const VINEXT_APP_VARY_HEADER = [
  ...VINEXT_APP_BASE_VARY_HEADERS.slice(0, 4),
  NEXT_URL_HEADER,
  ...VINEXT_APP_BASE_VARY_HEADERS.slice(4),
].join(", ");

/** RSC response identity for requests without active interception context. */
export const VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER = `${VINEXT_APP_NON_CONTEXTUAL_VARY_HEADER}, Accept`;

/** RSC response identity for requests whose interception context can affect the payload. */
export const VINEXT_RSC_VARY_HEADER = `${VINEXT_APP_VARY_HEADER}, Accept`;

type CreateRscRequestHeadersOptions = {
  clientReuseManifestHeader?: string | null;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  mountedSlotsHeader?: string | null;
  includePrefetchHeader?: boolean;
  renderMode?: AppRscRenderMode;
  fetchPriority?: "auto" | "high" | "low";
  nextUrl?: string | null;
  deploymentId?: string;
  prefetchRouterState?: {
    pathAndSearch: string;
    routeId: string;
  } | null;
  routerState?: AppRscStateFingerprintInput | null;
};

type ResolveInvalidRscCacheBustingRequestOptions = {
  /** Treat this exact route as a candidate while a trusted prerender probe validates its response. */
  allowUnlistedPrewarmProbe?: boolean;
  isRscRequest: boolean;
  request: Request;
  cacheKeyMode?: RscCacheKeyMode;
  validateDocumentRequest?: boolean;
};

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

async function computePreviousRscCacheBustingSearchParam(headers: Headers): Promise<string | null> {
  const input = createRscCacheBustingInput(headers, {
    includeClientReuseManifestHeader: false,
    includeInterceptionIdHeader: false,
    includeRenderModeHeader: false,
    includeStateFingerprintHeader: false,
  });
  if (input === null) {
    return null;
  }

  return sha256RscCacheBustingHash(input);
}

function computePreviousLegacyRscCacheBustingSearchParam(headers: Headers): string | null {
  const input = createRscCacheBustingInput(headers, {
    includeClientReuseManifestHeader: false,
    includeInterceptionIdHeader: false,
    includeRenderModeHeader: false,
    includeStateFingerprintHeader: false,
  });
  return input === null
    ? null
    : computeLegacyRscCacheBustingSearchParam(headers, {
        includeClientReuseManifestHeader: false,
        includeInterceptionIdHeader: false,
        includeRenderModeHeader: false,
        includeStateFingerprintHeader: false,
      });
}

async function computePreviousClientReuseRscCacheBustingSearchParam(
  headers: Headers,
): Promise<string | null> {
  const input = createRscCacheBustingInput(headers, { includeClientReuseManifestHeader: false });
  return input === null ? null : sha256RscCacheBustingHash(input);
}

function computePreviousClientReuseLegacyRscCacheBustingSearchParam(
  headers: Headers,
): string | null {
  const input = createRscCacheBustingInput(headers, { includeClientReuseManifestHeader: false });
  return input === null
    ? null
    : computeLegacyRscCacheBustingSearchParam(headers, {
        includeClientReuseManifestHeader: false,
      });
}

export function createRscRequestHeaders(options: CreateRscRequestHeadersOptions = {}): Headers {
  const headers = new Headers({
    Accept: VINEXT_RSC_CONTENT_TYPE,
    [RSC_HEADER]: "1",
  });
  if ("deploymentId" in options) {
    if (options.deploymentId) applyDeploymentIdHeader(headers, options.deploymentId);
  } else {
    applyDeploymentIdHeader(headers);
  }

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
 * Preserve the semantic request variant in browser-local cache keys even when
 * the network URL is canonicalized for a response-`Vary` cache. This prevents
 * route-tree and loading-shell payloads from colliding with the complete RSC
 * response stored for navigation.
 */
export function createServerActionRequestUrl(href: string): string {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const url = new URL(beforeHash, "http://vinext.local");
  return `${url.pathname}${url.search}`;
}

function createRscCacheBustingRedirect(location: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      [VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER]: "1",
    },
  });
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

  const unmarkedDestination = new URL(destinationUrl);
  stripRscCacheBustingSearchParam(unmarkedDestination);
  const destinationIsPrewarmEligible =
    unmarkedDestination.search === "" &&
    isServerRscPrewarmEligiblePathname(
      stripRscSuffix(unmarkedDestination.pathname),
      process.env.__NEXT_ROUTER_BASEPATH ?? "",
    );

  const rscPath = await createRscRequestUrl(
    `${destinationUrl.pathname}${destinationUrl.search}`,
    request.headers,
    getRscCacheKeyMode() === "response-vary" &&
      destinationIsPrewarmEligible &&
      isCanonicalSharedRscRequestHeaders(request.headers)
      ? "response-vary"
      : "header-digest",
  );
  return `${destinationUrl.origin}${rscPath}`;
}

export async function resolveInvalidRscCacheBustingRequest(
  options: ResolveInvalidRscCacheBustingRequestOptions,
): Promise<Response | null> {
  if (options.request.method !== "GET" && options.request.method !== "HEAD") {
    return null;
  }

  const url = new URL(options.request.url);
  if (!options.isRscRequest) {
    if (options.validateDocumentRequest === false) return null;
    if (!hasRscCacheBustingSearchParam(url)) return null;
    stripRscCacheBustingSearchParam(url);
    return createRscCacheBustingRedirect(`${url.pathname}${url.search}`);
  }

  const cacheKeyMode = options.cacheKeyMode ?? getRscCacheKeyMode();
  if (cacheKeyMode === "response-vary") {
    const responseVaryResult = resolveResponseVaryRscCacheBustingRequest({
      allowUnlistedPrewarmProbe: options.allowUnlistedPrewarmProbe,
      request: options.request,
    });
    if (responseVaryResult !== undefined) return responseVaryResult;
  }

  const actualHash = url.searchParams.get(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM);
  const expectedHash = await computeRscCacheBustingSearchParam(options.request.headers);

  if (actualHash === null && url.pathname.endsWith(".rsc") && expectedHash === "") {
    return null;
  }

  const acceptedHashes = new Set<string>([expectedHash]);
  if (actualHash !== null && actualHash !== expectedHash) {
    acceptedHashes.add(computeLegacyRscCacheBustingSearchParam(options.request.headers));
    // A request carrying the new reuse-manifest field can render a partial
    // payload, so accepting the pre-field digest would alias it with the full
    // response in URL-only caches. Compatibility is safe only when the field
    // is absent and both request generations describe the same payload.
    if (!options.request.headers.has(VINEXT_CLIENT_REUSE_MANIFEST_HEADER)) {
      const previousClientReuseHash = await computePreviousClientReuseRscCacheBustingSearchParam(
        options.request.headers,
      );
      const previousClientReuseLegacyHash =
        computePreviousClientReuseLegacyRscCacheBustingSearchParam(options.request.headers);
      if (previousClientReuseHash !== null) acceptedHashes.add(previousClientReuseHash);
      if (previousClientReuseLegacyHash !== null) {
        acceptedHashes.add(previousClientReuseLegacyHash);
      }
    }
    if (
      !options.request.headers.has(VINEXT_CLIENT_REUSE_MANIFEST_HEADER) &&
      !options.request.headers.has(VINEXT_INTERCEPTION_ID_HEADER) &&
      normalizeRscRenderModeHeaderValue(
        options.request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER),
      ) === null
    ) {
      const previousHash = await computePreviousRscCacheBustingSearchParam(options.request.headers);
      const previousLegacyHash = computePreviousLegacyRscCacheBustingSearchParam(
        options.request.headers,
      );
      if (previousHash !== null) acceptedHashes.add(previousHash);
      if (previousLegacyHash !== null) acceptedHashes.add(previousLegacyHash);
    }

    const compatibilityInputs: CreateRscCacheBustingInputOptions[] = [];
    const hasInterceptionId = options.request.headers.has(VINEXT_INTERCEPTION_ID_HEADER);
    const hasStateFingerprint = options.request.headers.has(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
    const hasNormalRenderMode =
      normalizeRscRenderModeHeaderValue(
        options.request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER),
      ) === null;
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
      const input = createRscCacheBustingInput(options.request.headers, compatibilityOptions);
      if (input === null) {
        acceptedHashes.add("");
      } else {
        acceptedHashes.add(await sha256RscCacheBustingHash(input));
        acceptedHashes.add(
          computeLegacyRscCacheBustingSearchParam(options.request.headers, compatibilityOptions),
        );
      }
    }
  }

  if (actualHash !== null && acceptedHashes.has(actualHash)) {
    return null;
  }

  setRscCacheBustingSearchParam(url, expectedHash);
  return createRscCacheBustingRedirect(`${url.pathname}${url.search}`);
}
