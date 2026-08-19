import type { NextHeader, NextI18nConfig } from "../config/next-config.js";
import type { AppRscPrewarmObservation } from "vinext/shims/rsc-prewarm-server";
import { preserveFullyBufferedBodyMetadata } from "vinext/shims/unified-request-context";
import {
  injectRscPrewarmManifestMeta,
  injectRscPrewarmManifestMetaHtml,
  removeRscPrewarmManifestInvalidatedHeaders,
} from "./app-rsc-prewarm-meta.js";
import { configRuleMayVaryAcrossPrewarmRequests } from "./prewarm-source-independence.js";
import { isServerRscPrewarmEligiblePathname } from "./rsc-prewarm-eligibility.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import {
  setRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
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
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
  VINEXT_PREWARM_SOURCE_INDEPENDENT_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "./headers.js";

export {
  injectRscPrewarmManifestMeta,
  injectRscPrewarmManifestMetaHtml,
  removeRscPrewarmManifestInvalidatedHeaders,
};

export { isServerRscPrewarmEligiblePathname };

const CANONICALIZED_RSC_REQUEST_HEADERS = new Set(
  [
    NEXT_ROUTER_PREFETCH_HEADER,
    NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
    NEXT_ROUTER_STATE_TREE_HEADER,
    NEXT_URL_HEADER,
    "Host",
  ].map((name) => name.toLowerCase()),
);

function varyDeclaresCanonicalizedRscHeader(vary: string | null): boolean {
  return (
    vary !== null &&
    vary
      .split(",")
      .some((token) => CANONICALIZED_RSC_REQUEST_HEADERS.has(token.trim().toLowerCase()))
  );
}

function configHeaderDeclaresCanonicalizedRscVary(rule: NextHeader): boolean {
  return rule.headers.some(
    ({ key, value }) => key.toLowerCase() === "vary" && varyDeclaresCanonicalizedRscHeader(value),
  );
}

/** Apply a framework-owned header even when userland returned immutable headers. */
function applyFrameworkResponseHeader(
  response: Response,
  name: string,
  value: string | null,
): Response {
  const apply = (headers: Headers): void => {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  };

  try {
    apply(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    apply(headers);
    return preserveFullyBufferedBodyMetadata(
      response,
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
  }
}

export function createAppRscPrewarmObservation(options: {
  hasConfigRules: boolean;
  i18nConfig: NextI18nConfig | null;
  request: Request;
  requestKind: "document" | "rsc";
}): AppRscPrewarmObservation | null {
  const isTrustedPrewarmProbe =
    process.env.VINEXT_PRERENDER === "1" &&
    options.request.headers.has(VINEXT_PRERENDER_SECRET_HEADER);

  let conditionalConfigPathMatched = false;
  let conditionalMiddlewarePathMatched = false;
  let middlewareMatched = false;
  const hostname = new URL(options.request.url).hostname;
  const domainLocaleMatchPathnames = (pathname: string): string[] => {
    const pathnames = new Set([
      normalizeDefaultLocalePathname(pathname, options.i18nConfig, { hostname }),
    ]);
    for (const domain of options.i18nConfig?.domains ?? []) {
      pathnames.add(
        normalizeDefaultLocalePathname(pathname, options.i18nConfig, {
          hostname: domain.domain,
        }),
      );
    }
    return [...pathnames];
  };
  const configSourceVariesAcrossDomainLocales = (
    pathname: string,
    matches: (matchPathname: string) => boolean,
  ): boolean => {
    const domainPathnames = domainLocaleMatchPathnames(pathname);
    // Equal match booleans are not enough: locale captures can still produce
    // different header values or rewrite/redirect destinations. If host-based
    // locale normalization changes the pathname, fail closed for any rule that
    // can reach at least one of those domain-specific paths.
    return new Set(domainPathnames).size > 1 && domainPathnames.some(matches);
  };

  return {
    allowUnlistedPrewarmProbe: isTrustedPrewarmProbe,
    shouldLoadConfigMatchers: options.hasConfigRules,
    applySourceIndependentProof(response) {
      let finalized = applyFrameworkResponseHeader(
        response,
        VINEXT_PREWARM_SOURCE_INDEPENDENT_HEADER,
        null,
      );
      if (
        isTrustedPrewarmProbe &&
        !conditionalConfigPathMatched &&
        !conditionalMiddlewarePathMatched &&
        !middlewareMatched
      ) {
        finalized = applyFrameworkResponseHeader(
          finalized,
          VINEXT_PREWARM_SOURCE_INDEPENDENT_HEADER,
          "1",
        );
      }
      return finalized;
    },
    isSourceIndependent() {
      return (
        !conditionalConfigPathMatched && !conditionalMiddlewarePathMatched && !middlewareMatched
      );
    },
    observeConfigRules({
      basePathState,
      configHeaders,
      configMatchers,
      configRedirects,
      redirectPathname,
      requestCleanPathname,
    }) {
      conditionalConfigPathMatched ||= configHeaders.some((rule) => {
        const matches = (pathname: string) =>
          configMatchers.matchesHeaderSource(pathname, rule, basePathState);
        return (
          ((configRuleMayVaryAcrossPrewarmRequests(rule, options.requestKind) ||
            configHeaderDeclaresCanonicalizedRscVary(rule)) &&
            matches(redirectPathname)) ||
          configSourceVariesAcrossDomainLocales(requestCleanPathname, matches)
        );
      });
      conditionalConfigPathMatched ||= configRedirects.some((rule) => {
        const matches = (pathname: string) =>
          configMatchers.matchesRedirectSource(pathname, rule, basePathState);
        return (
          (configRuleMayVaryAcrossPrewarmRequests(rule, options.requestKind) &&
            matches(redirectPathname)) ||
          configSourceVariesAcrossDomainLocales(requestCleanPathname, matches)
        );
      });
    },
    observeExternalResponse(_response) {
      // External origins cannot provide framework-owned proof that a payload
      // is independent of credentials and source-route context. Keep their RSC
      // requests on the contextual digest URL and out of deploy prewarming,
      // even though the final response policy still crosses the cache adapter.
      conditionalConfigPathMatched = true;
    },
    observeMiddleware({ conditionalPathMatched, matched }) {
      conditionalMiddlewarePathMatched ||= conditionalPathMatched;
      middlewareMatched ||= matched;
    },
    observeRewrite({ basePathState, configMatchers, pathname, rewrite, rewritePathname }) {
      if (
        (configRuleMayVaryAcrossPrewarmRequests(rewrite, options.requestKind) &&
          configMatchers.matchesRewriteSource(rewritePathname, rewrite, basePathState)) ||
        configSourceVariesAcrossDomainLocales(pathname, (candidate) =>
          configMatchers.matchesRewriteSource(candidate, rewrite, basePathState),
        )
      ) {
        conditionalConfigPathMatched = true;
      }
    },
  };
}

const SHARED_RSC_VARIANT_HEADERS = [
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
] as const;

function hasCanonicalSharedRscVariantHeaders(headers: Headers): boolean {
  return (
    headers.get(RSC_HEADER) === "1" &&
    !SHARED_RSC_VARIANT_HEADERS.some((header) => headers.has(header))
  );
}

export function isCanonicalSharedRscRequestHeaders(headers: Headers): boolean {
  return (
    headers.get("Accept") === VINEXT_RSC_CONTENT_TYPE &&
    hasCanonicalSharedRscVariantHeaders(headers)
  );
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

export function resolveResponseVaryRscCacheBustingRequest(options: {
  allowUnlistedPrewarmProbe?: boolean;
  request: Request;
}): Response | null | undefined {
  const url = new URL(options.request.url);
  const unmarkedUrl = new URL(url);
  stripRscCacheBustingSearchParam(unmarkedUrl);
  const isPrewarmEligibleUrl =
    unmarkedUrl.search === "" &&
    (options.allowUnlistedPrewarmProbe === true ||
      isServerRscPrewarmEligiblePathname(
        stripRscSuffix(unmarkedUrl.pathname),
        process.env.__NEXT_ROUTER_BASEPATH ?? "",
      ));

  if (isPrewarmEligibleUrl && isCanonicalSharedRscRequestHeaders(options.request.headers)) {
    const canonicalUrl = new URL(url);
    const canonicalPathname = stripRscSuffix(canonicalUrl.pathname);
    if (
      canonicalPathname !== canonicalUrl.pathname &&
      options.request.headers.get(RSC_HEADER) !== "1"
    ) {
      return null;
    }
    canonicalUrl.pathname = canonicalPathname;
    setRscCacheBustingSearchParam(canonicalUrl, "");
    if (url.pathname === canonicalUrl.pathname && url.search === canonicalUrl.search) return null;
    return createRscCacheBustingRedirect(`${canonicalUrl.pathname}${canonicalUrl.search}`);
  }

  if (
    hasCanonicalSharedRscVariantHeaders(options.request.headers) &&
    (!isPrewarmEligibleUrl || !isCanonicalSharedRscRequestHeaders(options.request.headers)) &&
    stripRscSuffix(url.pathname) === url.pathname
  ) {
    const compatibilityUrl = new URL(url);
    compatibilityUrl.pathname += ".rsc";
    setRscCacheBustingSearchParam(compatibilityUrl, "");
    return createRscCacheBustingRedirect(`${compatibilityUrl.pathname}${compatibilityUrl.search}`);
  }

  // Undefined means the ordinary header-digest compatibility path should run.
  return undefined;
}
