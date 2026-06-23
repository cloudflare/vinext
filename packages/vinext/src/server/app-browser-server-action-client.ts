import {
  createFromFetch,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
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
import { throwOnServerActionNotFound } from "./server-action-not-found.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
} from "./headers.js";

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
  ): Promise<unknown>;
  navigationPlanner: typeof import("./navigation-planner.js").navigationPlanner;
  performHardNavigation(url: string, historyMode?: "assign" | "replace"): void;
  renderRedirectPayload(
    elements: AppElements,
    target: ActionRedirectTarget,
    actionInitiation: ClientServerActionInitiation,
  ): void;
  syncCurrentHistoryState(
    previousNextUrl: string | null,
    bfcacheIds: Readonly<Record<string, string>>,
  ): void;
  syncServerActionHttpFallbackHead(status: number | null): void;
};

function resolveActionRedirectTarget(
  response: Response,
  performHardNavigation: ClientServerActionDeps["performHardNavigation"],
): ActionRedirectTarget | null {
  const actionRedirect = response.headers.get(ACTION_REDIRECT_HEADER);
  if (!actionRedirect) return null;

  if (isDangerousScheme(actionRedirect)) {
    console.error(DANGEROUS_URL_BLOCK_MESSAGE);
    return null;
  }

  try {
    let redirectUrl: URL;
    if (actionRedirect.startsWith("/") || /^[a-z]+:/i.test(actionRedirect)) {
      redirectUrl = new URL(actionRedirect, window.location.href);
    } else {
      const baseParsed = new URL(window.location.href);
      let baseDir = baseParsed.pathname;
      if (!baseDir.endsWith("/")) baseDir += "/";
      redirectUrl = new URL(actionRedirect, `${baseParsed.origin}${baseDir}${baseParsed.search}`);
    }

    if (redirectUrl.origin !== window.location.origin) {
      performHardNavigation(actionRedirect);
      return null;
    }
    const statusHeader = response.headers.get(ACTION_REDIRECT_STATUS_HEADER);
    return {
      href: redirectUrl.href,
      type: response.headers.get(ACTION_REDIRECT_TYPE_HEADER) ?? "push",
      status: statusHeader ? parseInt(statusHeader, 10) : 307,
    };
  } catch {
    performHardNavigation(actionRedirect);
    return null;
  }
}

class ServerActionRedirectError extends Error {
  readonly digest: string;
  readonly handled = true;

  constructor(target: ActionRedirectTarget) {
    super("NEXT_REDIRECT");
    const redirectUrl = new URL(target.href, window.location.href);
    const redirectHref = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
    const redirectType = target.type === "push" ? "push" : "replace";
    this.digest = `NEXT_REDIRECT;${redirectType};${encodeURIComponent(redirectHref)};${target.status};`;
  }
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
    previousNextUrl: actionInitiation.routerState.previousNextUrl,
  }).headers;
  const fetchResponse = await fetch(createServerActionRequestUrl(actionInitiation.path), {
    method: "POST",
    headers,
    body,
  });

  throwOnServerActionNotFound(fetchResponse, id);

  const hasActionRedirect = fetchResponse.headers.has(ACTION_REDIRECT_HEADER);
  const actionRedirectTarget = resolveActionRedirectTarget(fetchResponse, (url, historyMode) =>
    deps.performHardNavigation(url, historyMode),
  );
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
  if (
    applyServerActionResultDecision(
      actionResultDecision,
      () => deps.clearClientNavigationCaches(),
      (url, historyMode) => deps.performHardNavigation(url, historyMode),
    )
  ) {
    return undefined;
  }

  const revalidation = parseServerActionRevalidationHeader(fetchResponse.headers);
  if (revalidation !== "none") deps.clearClientNavigationCaches();
  const invalidResponseError = await readInvalidServerActionResponseError(
    fetchResponse.clone(),
    actionRedirectTarget !== null,
  );
  if (invalidResponseError) throw invalidResponseError;
  if (actionRedirectTarget && !fetchResponseIsRsc) {
    deps.performHardNavigation(actionRedirectTarget.href);
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
    if (isServerActionResult(result) && result.root !== undefined) {
      deps.renderRedirectPayload(
        AppElementsWire.decode(result.root),
        actionRedirectTarget,
        actionInitiation,
      );
      throw new ServerActionRedirectError(actionRedirectTarget);
    }
    deps.performHardNavigation(actionRedirectTarget.href);
    return undefined;
  }

  deps.syncServerActionHttpFallbackHead(
    shouldSyncServerActionHttpFallbackHead(result) ? fetchResponse.status : null,
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
      );
    }
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
  );
}
