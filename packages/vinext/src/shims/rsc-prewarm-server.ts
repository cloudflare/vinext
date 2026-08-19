import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { BasePathMatchState } from "../config/config-matchers.js";

export type AppRscPrewarmConfigMatchers = {
  matchesHeaderSource(
    pathname: string,
    rule: NextHeader,
    basePathState?: BasePathMatchState,
  ): boolean;
  matchesRedirectSource(
    pathname: string,
    rule: NextRedirect,
    basePathState?: BasePathMatchState,
  ): boolean;
  matchesRewriteSource(
    pathname: string,
    rule: NextRewrite,
    basePathState?: BasePathMatchState,
  ): boolean;
};

export type AppRscPrewarmObservation = {
  readonly allowUnlistedPrewarmProbe: boolean;
  readonly shouldLoadConfigMatchers: boolean;
  applySourceIndependentProof(response: Response): Response;
  observeConfigRules(options: {
    basePathState: BasePathMatchState;
    configHeaders: readonly NextHeader[];
    configMatchers: AppRscPrewarmConfigMatchers;
    configRedirects: readonly NextRedirect[];
    redirectPathname: string;
    requestCleanPathname: string;
  }): void;
  observeExternalResponse(response: Response): void;
  observeMiddleware(options: { conditionalPathMatched: boolean; matched: boolean }): void;
  observeRewrite(options: {
    basePathState: BasePathMatchState;
    configMatchers: AppRscPrewarmConfigMatchers;
    pathname: string;
    rewrite: NextRewrite;
    rewritePathname: string;
  }): void;
};

export type RscPrewarmServerImplementation = {
  createAppRscPrewarmObservation(options: {
    hasConfigRules: boolean;
    i18nConfig: NextI18nConfig | null;
    request: Request;
    requestKind: "document" | "rsc";
  }): AppRscPrewarmObservation | null;
  injectRscPrewarmManifestMeta(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  injectRscPrewarmManifestMetaHtml(html: string): string;
  isServerRscPrewarmEligiblePathname(pathname: string, basePath?: string): boolean;
  isCanonicalSharedRscRequestHeaders(headers: Headers): boolean;
  removeRscPrewarmManifestInvalidatedHeaders(headers: Headers): void;
  resolveResponseVaryRscCacheBustingRequest(options: {
    allowUnlistedPrewarmProbe?: boolean;
    request: Request;
  }): Response | null | undefined;
};

type RscPrewarmServerState = {
  implementation: RscPrewarmServerImplementation | null;
};

const RSC_PREWARM_SERVER_STATE = Symbol.for("vinext.rscPrewarmServer");

function getState(): RscPrewarmServerState {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: RscPrewarmServerState | undefined;
  };
  return (registry[RSC_PREWARM_SERVER_STATE] ??= { implementation: null });
}

function isResponseVaryRscCacheEnabled(): boolean {
  return (
    process.env.__VINEXT_RSC_CACHE_KEY_MODE === "response-vary" ||
    getState().implementation !== null
  );
}

export function registerRscPrewarmServerImplementation(
  implementation: RscPrewarmServerImplementation,
): void {
  getState().implementation = implementation;
}

export function createAppRscPrewarmObservation(options: {
  hasConfigRules: boolean;
  i18nConfig: NextI18nConfig | null;
  request: Request;
  requestKind: "document" | "rsc";
}): AppRscPrewarmObservation | null {
  if (!isResponseVaryRscCacheEnabled()) return null;
  return getState().implementation?.createAppRscPrewarmObservation(options) ?? null;
}

export function isServerRscPrewarmEligiblePathname(pathname: string, basePath = ""): boolean {
  if (!isResponseVaryRscCacheEnabled()) return false;
  return getState().implementation?.isServerRscPrewarmEligiblePathname(pathname, basePath) ?? false;
}

export function isCanonicalSharedRscRequestHeaders(headers: Headers): boolean {
  if (!isResponseVaryRscCacheEnabled()) return false;
  return getState().implementation?.isCanonicalSharedRscRequestHeaders(headers) ?? false;
}

export function resolveResponseVaryRscCacheBustingRequest(options: {
  allowUnlistedPrewarmProbe?: boolean;
  request: Request;
}): Response | null | undefined {
  if (!isResponseVaryRscCacheEnabled()) return undefined;
  return getState().implementation?.resolveResponseVaryRscCacheBustingRequest(options);
}

export function injectRscPrewarmManifestMetaHtml(html: string): string {
  if (!isResponseVaryRscCacheEnabled()) return html;
  return getState().implementation?.injectRscPrewarmManifestMetaHtml(html) ?? html;
}

export function injectRscPrewarmManifestMeta(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (!isResponseVaryRscCacheEnabled()) return body;
  return getState().implementation?.injectRscPrewarmManifestMeta(body) ?? body;
}

export function removeRscPrewarmManifestInvalidatedHeaders(headers: Headers): void {
  if (!isResponseVaryRscCacheEnabled()) return;
  getState().implementation?.removeRscPrewarmManifestInvalidatedHeaders(headers);
}

/** Test-only reset for source-level module tests without a generated bootstrap. */
export function resetRscPrewarmServerImplementationForTesting(): void {
  getState().implementation = null;
}
