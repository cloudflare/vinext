import {
  createFromFetch,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import { parseRenderedPathAndSearchHeader } from "vinext/shims/app-router-navigation";
import { DANGEROUS_URL_BLOCK_MESSAGE, isDangerousScheme } from "vinext/shims/url-safety";
import {
  createServerActionResultFacts,
  isServerActionResult,
  normalizeServerActionThrownValue,
  parseServerActionRevalidationHeader,
  readInvalidServerActionResponseError,
  shouldClearClientNavigationCachesForServerActionResult,
  shouldSyncServerActionHttpFallbackHead,
  type AppBrowserServerActionResult,
  type ServerActionRevalidationKind,
} from "./app-browser-action-result.js";
import { applyServerActionResultDecision } from "./app-browser-server-action-navigation.js";
import { resolveServerActionRequestState, type AppRouterState } from "./app-browser-state.js";
import { AppElementsWire, type AppElements, type AppWireElements } from "./app-elements.js";
import {
  createServerActionRequestUrl,
  toPathAbsolutePathname,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
} from "./app-rsc-cache-busting.js";
import { throwOnServerActionNotFound } from "./server-action-not-found.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "./headers.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";

type ServerActionResult = AppBrowserServerActionResult<AppWireElements>;

export type ClientServerActionInitiation = {
  href: string;
  navigationId: number;
  path: string;
  routerState: AppRouterState;
};

type ActionRedirectTarget = {
  href: string;
  type: string;
  /** The path and query the server rendered the target with, when known. */
  renderedPathAndSearch: string | null;
};

export type ClientServerActionDeps = {
  basePath: string;
  clearClientNavigationCaches(): void;
  /** Evict only the cached navigation data that may be dynamic. */
  clearDynamicClientNavigationCaches(): void;
  clientRscCompatibilityId: string | null;
  commitSameUrlNavigatePayload(
    elements: Promise<AppElements>,
    actionInitiation: ClientServerActionInitiation,
    returnValue: ServerActionResult["returnValue"] | undefined,
    revalidation: ServerActionRevalidationKind,
    renderedPathAndSearch: string | null,
  ): Promise<unknown>;
  navigationPlanner: typeof import("./navigation-planner.js").navigationPlanner;
  performHardNavigation(url: string, historyMode?: "assign" | "replace"): void;
  renderRedirectPayload(
    elements: AppElements,
    target: ActionRedirectTarget,
    actionInitiation: ClientServerActionInitiation,
    revalidation: ServerActionRevalidationKind,
  ): void;
  syncCurrentHistoryState(
    previousNextUrl: string | null,
    bfcacheIds: Readonly<Record<string, string>>,
  ): void;
  syncServerActionHttpFallbackHead(status: number | null): void;
};

function resolveActionRedirectTarget(
  response: Response,
  basePath: string,
  performHardNavigation: ClientServerActionDeps["performHardNavigation"],
): ActionRedirectTarget | null {
  const actionRedirect = response.headers.get(ACTION_REDIRECT_HEADER);
  if (!actionRedirect) return null;

  if (isDangerousScheme(actionRedirect)) {
    console.error(DANGEROUS_URL_BLOCK_MESSAGE);
    return null;
  }

  const type = response.headers.get(ACTION_REDIRECT_TYPE_HEADER) ?? "push";
  let redirectUrl: URL;
  try {
    if (actionRedirect.startsWith("/") || /^[a-z]+:/i.test(actionRedirect)) {
      redirectUrl = new URL(actionRedirect, window.location.href);
    } else {
      const baseParsed = new URL(window.location.href);
      let baseDir = baseParsed.pathname;
      if (!baseDir.endsWith("/")) baseDir += "/";
      redirectUrl = new URL(actionRedirect, `${baseParsed.origin}${baseDir}${baseParsed.search}`);
    }
  } catch {
    performHardNavigation(actionRedirect);
    throw new ServerActionRedirectError({ href: actionRedirect, type }, basePath);
  }

  if (
    redirectUrl.origin !== window.location.origin ||
    (basePath !== "" && !hasBasePath(redirectUrl.pathname, basePath))
  ) {
    // As in Next.js, the caller's promise rejects with the redirect error
    // while the document navigates.
    performHardNavigation(actionRedirect);
    throw new ServerActionRedirectError({ href: redirectUrl.href, type }, basePath);
  }
  return {
    href: redirectUrl.href,
    type,
    // The target's own render, which a rewrite may give another query.
    renderedPathAndSearch: parseRenderedPathAndSearchHeader(
      response.headers.get(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER),
    ),
  };
}

class ServerActionRedirectError extends Error {
  readonly digest: string;
  readonly handled = true;

  // Like Next.js' createRedirectErrorForAction: an internal target loses its
  // basePath, an external one keeps its full URL, and the status is always
  // the default 307, even for permanentRedirect(); only the HTTP response
  // carries the permanent status.
  constructor(target: Pick<ActionRedirectTarget, "href" | "type">, basePath: string) {
    super("NEXT_REDIRECT");
    let redirectHref = target.href;
    try {
      const redirectUrl = new URL(target.href, window.location.href);
      redirectHref =
        redirectUrl.origin === window.location.origin
          ? toPathAbsolutePathname(stripBasePath(redirectUrl.pathname, basePath)) +
            redirectUrl.search +
            redirectUrl.hash
          : redirectUrl.href;
    } catch {}
    const redirectType = target.type === "push" ? "push" : "replace";
    this.digest = `NEXT_REDIRECT;${redirectType};${redirectHref};307;`;
  }
}

async function readServerActionReturnValue(
  result: ServerActionResult | AppWireElements,
  responseStatus: number,
): Promise<unknown> {
  if (!isServerActionResult(result) || !result.returnValue) return undefined;
  if (!result.returnValue.ok) {
    throw await normalizeServerActionThrownValue(result.returnValue.data, responseStatus);
  }
  return result.returnValue.data;
}

export async function invokeClientServerAction(
  id: string,
  args: unknown[],
  actionInitiation: ClientServerActionInitiation,
  deps: ClientServerActionDeps,
): Promise<unknown> {
  deps.syncServerActionHttpFallbackHead(null);
  const temporaryReferences = createTemporaryReferenceSet();
  deps.syncCurrentHistoryState(
    actionInitiation.routerState.previousNextUrl,
    actionInitiation.routerState.bfcacheIds,
  );
  const body = await encodeReply(args, { temporaryReferences });
  const headers = resolveServerActionRequestState({
    actionId: id,
    basePath: deps.basePath,
    elements: actionInitiation.routerState.elements,
    interceptionContext:
      actionInitiation.routerState.interception !== null
        ? actionInitiation.routerState.interceptionContext
        : null,
    previousNextUrl: actionInitiation.routerState.previousNextUrl,
  }).headers;
  const fetchResponse = await fetch(createServerActionRequestUrl(actionInitiation.path), {
    method: "POST",
    headers,
    body,
  });

  throwOnServerActionNotFound(fetchResponse, id);

  const hasActionRedirect = fetchResponse.headers.has(ACTION_REDIRECT_HEADER);
  const actionRedirectTarget = resolveActionRedirectTarget(
    fetchResponse,
    deps.basePath,
    (url, historyMode) => deps.performHardNavigation(url, historyMode),
  );
  // A redirect to a blocked scheme is dropped.
  if (hasActionRedirect && !actionRedirectTarget) return undefined;

  const actionResultFacts = createServerActionResultFacts({
    actionRedirectHref: actionRedirectTarget?.href ?? null,
    actionRedirectType: actionRedirectTarget?.type ?? null,
    clientCompatibilityId: deps.clientRscCompatibilityId,
    compatibilityIdHeader: fetchResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
    contentTypeHeader: fetchResponse.headers.get("content-type"),
    currentHref: actionInitiation.href,
    origin: window.location.origin,
    responseUrl: fetchResponse.url,
  });
  const fetchResponseIsRsc = actionResultFacts.isRscContentType;
  const actionResultDecision = deps.navigationPlanner.classifyServerActionResult(actionResultFacts);
  const applyHardNavigationDecision = () =>
    applyServerActionResultDecision(
      actionResultDecision,
      () => deps.clearClientNavigationCaches(),
      (url, historyMode) => deps.performHardNavigation(url, historyMode),
    );
  if (actionResultDecision.kind === "hardNavigate") {
    // A response from another build loads the page as a document. The action
    // still ran, so, as in Next.js, its caller gets its outcome: the redirect
    // error, or its result with the newer build's tree discarded.
    if (actionRedirectTarget) {
      applyHardNavigationDecision();
      throw new ServerActionRedirectError(actionRedirectTarget, deps.basePath);
    }
    let skewedResult: ServerActionResult | AppWireElements;
    try {
      skewedResult = await createFromFetch<ServerActionResult | AppWireElements>(
        Promise.resolve(fetchResponse),
        { temporaryReferences },
      );
    } finally {
      applyHardNavigationDecision();
    }
    return readServerActionReturnValue(skewedResult, fetchResponse.status);
  }

  const revalidation = parseServerActionRevalidationHeader(fetchResponse.headers);
  // Like Next.js, `refresh()` alone keeps the static prefetches.
  if (revalidation === "staticAndDynamic") deps.clearClientNavigationCaches();
  else if (revalidation === "dynamicOnly") deps.clearDynamicClientNavigationCaches();
  const invalidResponseError = await readInvalidServerActionResponseError(
    fetchResponse.clone(),
    actionRedirectTarget !== null,
  );
  if (invalidResponseError) throw invalidResponseError;
  if (actionRedirectTarget && !fetchResponseIsRsc) {
    deps.performHardNavigation(actionRedirectTarget.href);
    throw new ServerActionRedirectError(actionRedirectTarget, deps.basePath);
  }

  const flightResponse =
    fetchResponse.status === 303
      ? new Response(fetchResponse.body, {
          headers: fetchResponse.headers,
          status: 200,
          statusText: "OK",
        })
      : fetchResponse;
  const result = await createFromFetch<ServerActionResult | AppWireElements>(
    Promise.resolve(flightResponse),
    { temporaryReferences },
  );
  if (
    revalidation === "none" &&
    shouldClearClientNavigationCachesForServerActionResult(result, revalidation)
  ) {
    deps.clearClientNavigationCaches();
  }

  if (actionRedirectTarget) {
    const redirectRoot = isServerActionResult(result) ? result.root : result;
    if (redirectRoot !== undefined) {
      deps.renderRedirectPayload(
        AppElementsWire.decode(redirectRoot),
        actionRedirectTarget,
        actionInitiation,
        revalidation,
      );
      throw new ServerActionRedirectError(actionRedirectTarget, deps.basePath);
    }
    deps.performHardNavigation(actionRedirectTarget.href);
    throw new ServerActionRedirectError(actionRedirectTarget, deps.basePath);
  }

  deps.syncServerActionHttpFallbackHead(
    shouldSyncServerActionHttpFallbackHead(result) ? fetchResponse.status : null,
  );
  // A rewrite on the POST can re-render the page with another query.
  const renderedPathAndSearch = parseRenderedPathAndSearchHeader(
    fetchResponse.headers.get(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER),
  );

  if (isServerActionResult(result)) {
    if (result.root !== undefined) {
      const returnValue =
        result.returnValue && !result.returnValue.ok
          ? {
              ok: false,
              // Commit the tree without waiting for the rejection, as Next.js
              // does; the commit throws the thrown value once it settles.
              data: normalizeServerActionThrownValue(result.returnValue.data, fetchResponse.status),
            }
          : result.returnValue;
      return deps.commitSameUrlNavigatePayload(
        Promise.resolve(AppElementsWire.decode(result.root)),
        actionInitiation,
        returnValue,
        revalidation,
        renderedPathAndSearch,
      );
    }
    return readServerActionReturnValue(result, fetchResponse.status);
  }

  return deps.commitSameUrlNavigatePayload(
    Promise.resolve(AppElementsWire.decode(result)),
    actionInitiation,
    undefined,
    revalidation,
    renderedPathAndSearch,
  );
}
