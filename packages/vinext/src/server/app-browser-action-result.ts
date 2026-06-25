import { ACTION_REVALIDATED_HEADER } from "./headers.js";
import { VINEXT_RSC_CONTENT_TYPE } from "./app-rsc-cache-busting.js";
import { ServerActionResultFacts } from "./navigation-planner.js";

export type AppBrowserServerActionResult<TRoot> = {
  root?: TRoot;
  returnValue?: {
    ok: boolean;
    data: unknown;
  };
};

export type ServerActionRevalidationKind = "dynamicOnly" | "none" | "staticAndDynamic";

const ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC = 1;
const ACTION_DID_REVALIDATE_DYNAMIC_ONLY = 2;

type ServerActionInitiationSnapshot<TRouterState> = {
  href: string;
  navigationId: number;
  path: string;
  routerState: TRouterState;
};

/**
 * Structural discriminator: matches on `"returnValue"` or `"root"` keys.
 * This is safe because {@link AppWireElements} keys are prefixed (`route:`,
 * `slot:`, `__route`, etc.) and will never collide with these property names.
 * If the wire format ever adds a `"root"` key, this guard must be updated.
 */
export function isServerActionResult<TRoot>(
  value: unknown,
): value is AppBrowserServerActionResult<TRoot> {
  return !!value && typeof value === "object" && ("returnValue" in value || "root" in value);
}

export function shouldClearClientNavigationCachesForServerActionResult<TRoot>(
  result: AppBrowserServerActionResult<TRoot> | TRoot,
  revalidation: ServerActionRevalidationKind = "none",
): boolean {
  if (revalidation !== "none") {
    return true;
  }

  if (!isServerActionResult<TRoot>(result)) {
    return true;
  }

  return result.root !== undefined;
}

export function parseServerActionRevalidationHeader(
  headers: Pick<Headers, "get">,
): ServerActionRevalidationKind {
  const value = headers.get(ACTION_REVALIDATED_HEADER);
  if (!value) return "none";

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "none";
  }

  switch (parsed) {
    case ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC:
      return "staticAndDynamic";
    case ACTION_DID_REVALIDATE_DYNAMIC_ONLY:
      return "dynamicOnly";
    default:
      return "none";
  }
}

function createServerActionHttpFallbackError(status: number): (Error & { digest: string }) | null {
  if (status !== 401 && status !== 403 && status !== 404) return null;

  const digest =
    status === 404 ? "NEXT_HTTP_ERROR_FALLBACK;404" : `NEXT_HTTP_ERROR_FALLBACK;${status}`;
  const error = new Error(status === 404 ? "NEXT_NOT_FOUND" : `NEXT_HTTP_ERROR_FALLBACK;${status}`);
  return Object.assign(error, { digest });
}

export function normalizeServerActionThrownValue(data: unknown, responseStatus: number): unknown {
  return createServerActionHttpFallbackError(responseStatus) ?? data;
}

export function shouldSyncServerActionHttpFallbackHead<TRoot>(
  result: AppBrowserServerActionResult<TRoot> | TRoot,
): boolean {
  if (!isServerActionResult<TRoot>(result) || result.root !== undefined) return false;

  return result.returnValue?.ok !== false;
}

export async function readInvalidServerActionResponseError(
  response: Pick<Response, "headers" | "status" | "text">,
  hasRedirectLocation: boolean,
): Promise<Error | null> {
  const contentType = response.headers.get("content-type") ?? "";
  const isRscResponse = contentType.startsWith(VINEXT_RSC_CONTENT_TYPE);
  if (isRscResponse || hasRedirectLocation) return null;

  // Parity with Next.js' server-action reducer: any non-RSC action response,
  // including a 2xx, is surfaced to the action caller. Plain text 4xx/5xx
  // bodies are preserved when available; other responses use a stable generic
  // message.
  const message =
    response.status >= 400 && contentType.toLowerCase().startsWith("text/plain")
      ? await response.text()
      : "An unexpected response was received from the server.";

  return new Error(message || "An unexpected response was received from the server.");
}

export type ServerActionResultResponseFactsInput = {
  actionRedirectHref: string | null;
  actionRedirectType: string | null;
  clientCompatibilityId: string | null;
  contentTypeHeader: string | null;
  compatibilityIdHeader: string | null;
  currentHref: string;
  origin: string;
  responseUrl: string | null;
};

/**
 * Converts raw browser response data into the narrow facts expected by the
 * navigation planner. This is the single place where redirect-type
 * normalisation and RSC content-type detection happen for server-action
 * compatibility checks.
 */
export function createServerActionResultFacts(
  input: ServerActionResultResponseFactsInput,
): ServerActionResultFacts {
  return {
    actionRedirectHref: input.actionRedirectHref,
    actionRedirectType: input.actionRedirectType === "push" ? "push" : "replace",
    clientCompatibilityId: input.clientCompatibilityId,
    compatibilityIdHeader: input.compatibilityIdHeader,
    currentHref: input.currentHref,
    isRscContentType: (input.contentTypeHeader ?? "").startsWith(VINEXT_RSC_CONTENT_TYPE),
    origin: input.origin,
    responseUrl: input.responseUrl,
  };
}

export function shouldScheduleRefreshForDiscardedServerAction(
  revalidation: ServerActionRevalidationKind,
): boolean {
  return revalidation !== "none";
}

export function createServerActionInitiationSnapshot<TRouterState>(options: {
  href: string;
  navigationId: number;
  origin?: string;
  routerState: TRouterState;
}): ServerActionInitiationSnapshot<TRouterState> {
  const url =
    options.origin === undefined ? new URL(options.href) : new URL(options.href, options.origin);
  return {
    href: url.href,
    navigationId: options.navigationId,
    path: url.pathname + url.search,
    routerState: options.routerState,
  };
}

type DiscardedServerActionRefreshScheduler = {
  markNavigationSettled(): void;
  markNavigationStart(): void;
  schedule(): void;
};

type DiscardedServerActionRefreshSchedulerOptions = {
  queueTask?: (callback: () => void) => void;
  runRefresh: () => void;
};

export function createDiscardedServerActionRefreshScheduler(
  options: DiscardedServerActionRefreshSchedulerOptions,
): DiscardedServerActionRefreshScheduler {
  const queueTask = options.queueTask ?? queueMicrotask;
  let activeNavigationCount = 0;
  let flushQueued = false;
  let refreshPending = false;

  function flush(): void {
    flushQueued = false;
    if (!refreshPending || activeNavigationCount > 0) return;

    refreshPending = false;
    options.runRefresh();
  }

  function queueFlush(): void {
    if (flushQueued) return;
    flushQueued = true;
    queueTask(flush);
  }

  return {
    markNavigationSettled() {
      if (activeNavigationCount > 0) {
        activeNavigationCount -= 1;
      }
      queueFlush();
    },
    markNavigationStart() {
      activeNavigationCount += 1;
    },
    schedule() {
      refreshPending = true;
      queueFlush();
    },
  };
}
