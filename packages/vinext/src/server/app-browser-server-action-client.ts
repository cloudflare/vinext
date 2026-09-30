import {
  createFromFetch,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import { parseRenderedPathAndSearchHeader } from "vinext/shims/navigation";
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
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
} from "./app-rsc-cache-busting.js";
import {
  isServerActionNotFoundResponse,
  throwOnServerActionNotFound,
} from "./server-action-not-found.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "./headers.js";
import { hasBasePath } from "../utils/base-path.js";

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
  status: number;
  /** The path and query the server rendered the target with, when known. */
  renderedPathAndSearch: string | null;
};

export type ClientServerActionDeps = {
  basePath: string;
  clearClientNavigationCaches(): void;
  clientRscCompatibilityId: string | null;
  commitSameUrlNavigatePayload(
    elements: Promise<AppElements>,
    actionInitiation: ClientServerActionInitiation,
    returnValue: ServerActionResult["returnValue"] | undefined,
    revalidation: ServerActionRevalidationKind,
    renderedPathAndSearch: string | null,
    commitHooks?: { onCommitted?: () => void },
  ): Promise<unknown>;
  isCurrentAction?(): boolean;
  onRevalidationWithoutRender?(reason?: "document-navigation"): void;
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
  actionHref: string,
  performHardNavigation: ClientServerActionDeps["performHardNavigation"],
): ActionRedirectTarget | null {
  const actionRedirect = response.headers.get(ACTION_REDIRECT_HEADER);
  if (!actionRedirect) return null;

  let redirectUrl: URL;
  try {
    if (actionRedirect.startsWith("/") || /^[a-z]+:/i.test(actionRedirect)) {
      redirectUrl = new URL(actionRedirect, actionHref);
    } else {
      const baseParsed = new URL(actionHref);
      let baseDir = baseParsed.pathname;
      if (!baseDir.endsWith("/")) baseDir += "/";
      redirectUrl = new URL(actionRedirect, `${baseParsed.origin}${baseDir}${baseParsed.search}`);
    }
  } catch {
    performHardNavigation(actionRedirect);
    return null;
  }
  if (
    redirectUrl.origin !== window.location.origin ||
    (basePath !== "" && !hasBasePath(redirectUrl.pathname, basePath))
  ) {
    performHardNavigation(redirectUrl.href);
    return null;
  }
  const statusHeader = response.headers.get(ACTION_REDIRECT_STATUS_HEADER);
  return {
    href: redirectUrl.href,
    type: response.headers.get(ACTION_REDIRECT_TYPE_HEADER) ?? "push",
    status: statusHeader ? parseInt(statusHeader, 10) : 307,
    // The target's own render, which a rewrite may give another query.
    renderedPathAndSearch: parseRenderedPathAndSearchHeader(
      response.headers.get(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER),
    ),
  };
}

class ServerActionRedirectError extends Error {
  readonly digest: string;
  readonly handled = true;

  constructor(target: ActionRedirectTarget) {
    super("NEXT_REDIRECT");
    const redirectUrl = new URL(target.href, window.location.href);
    const redirectHref = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
    const redirectType = target.type === "push" ? "push" : "replace";
    this.digest = `NEXT_REDIRECT;${redirectType};${redirectHref};${target.status};`;
  }
}

export async function invokeClientServerAction(
  id: string,
  args: unknown[],
  actionInitiation: ClientServerActionInitiation,
  deps: ClientServerActionDeps,
): Promise<unknown> {
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

  const revalidation = parseServerActionRevalidationHeader(fetchResponse.headers);
  if (revalidation !== "none") deps.clearClientNavigationCaches();
  const canApplyNavigation = () => {
    if (deps.isCurrentAction?.() !== false) return true;
    if (revalidation !== "none") deps.onRevalidationWithoutRender?.();
    return false;
  };
  const performHardNavigation: ClientServerActionDeps["performHardNavigation"] = (url, mode) => {
    if (!canApplyNavigation()) return;
    try {
      deps.performHardNavigation(url, mode);
    } finally {
      if (revalidation !== "none") deps.onRevalidationWithoutRender?.("document-navigation");
    }
  };

  const hasActionRedirect = fetchResponse.headers.has(ACTION_REDIRECT_HEADER);
  if (isDangerousScheme(fetchResponse.headers.get(ACTION_REDIRECT_HEADER) ?? "")) {
    console.error(DANGEROUS_URL_BLOCK_MESSAGE);
    if (revalidation !== "none") deps.onRevalidationWithoutRender?.();
    return undefined;
  }
  const actionRedirectTarget = resolveActionRedirectTarget(
    fetchResponse,
    deps.basePath,
    actionInitiation.href,
    performHardNavigation,
  );
  if (hasActionRedirect && !actionRedirectTarget) return undefined;

  const actionResultFacts = createServerActionResultFacts({
    actionRedirectHref: actionRedirectTarget?.href ?? null,
    actionRedirectType: actionRedirectTarget?.type ?? null,
    clientCompatibilityId: deps.clientRscCompatibilityId,
    compatibilityIdHeader: fetchResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
    contentTypeHeader: fetchResponse.headers.get("content-type"),
    currentHref: actionInitiation.href,
    isServerActionNotFound: isServerActionNotFoundResponse(fetchResponse),
    origin: window.location.origin,
    responseUrl: fetchResponse.url,
  });
  const fetchResponseIsRsc = actionResultFacts.isRscContentType;
  const actionResultDecision = deps.navigationPlanner.classifyServerActionResult(actionResultFacts);
  if (
    applyServerActionResultDecision(
      actionResultDecision,
      () => deps.clearClientNavigationCaches(),
      performHardNavigation,
    )
  ) {
    return undefined;
  }

  // After the build check: an unknown action from a stale tab reloads, and only
  // an action missing from the tab's own build is reported to the caller.
  throwOnServerActionNotFound(fetchResponse, id);

  const invalidResponseError = await readInvalidServerActionResponseError(
    fetchResponse.clone(),
    actionRedirectTarget !== null,
  );
  if (invalidResponseError) throw invalidResponseError;
  if (actionRedirectTarget && !fetchResponseIsRsc) {
    performHardNavigation(actionRedirectTarget.href);
    return undefined;
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
      if (canApplyNavigation()) {
        deps.renderRedirectPayload(
          AppElementsWire.decode(redirectRoot),
          actionRedirectTarget,
          actionInitiation,
          revalidation,
        );
      }
      throw new ServerActionRedirectError(actionRedirectTarget);
    }
    performHardNavigation(actionRedirectTarget.href);
    return undefined;
  }

  // A discarded action must not touch the marker the current action owns. Its
  // return value still settles below.
  const ownsMarker = deps.isCurrentAction?.() !== false;
  // A re-rendered tree carries its own robots metadata, so the marker only
  // clears when that tree becomes visible. Other results change no tree and
  // write at once.
  const rendersTree = !isServerActionResult(result) || result.root !== undefined;
  const commitHooks =
    ownsMarker && rendersTree
      ? { onCommitted: () => deps.syncServerActionHttpFallbackHead(null) }
      : undefined;
  if (ownsMarker && !rendersTree) {
    deps.syncServerActionHttpFallbackHead(
      shouldSyncServerActionHttpFallbackHead(result) ? fetchResponse.status : null,
    );
  }
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
              data: normalizeServerActionThrownValue(result.returnValue.data, fetchResponse.status),
            }
          : result.returnValue;
      return deps.commitSameUrlNavigatePayload(
        Promise.resolve(AppElementsWire.decode(result.root)),
        actionInitiation,
        returnValue,
        revalidation,
        renderedPathAndSearch,
        commitHooks,
      );
    }
    if (revalidation !== "none") deps.onRevalidationWithoutRender?.();
    if (result.returnValue) {
      if (!result.returnValue.ok) {
        throw normalizeServerActionThrownValue(result.returnValue.data, fetchResponse.status);
      }
      return result.returnValue.data;
    }
    return undefined;
  }

  return deps.commitSameUrlNavigatePayload(
    Promise.resolve(AppElementsWire.decode(result)),
    actionInitiation,
    undefined,
    revalidation,
    renderedPathAndSearch,
    commitHooks,
  );
}
