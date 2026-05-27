import { ACTION_REVALIDATED_HEADER } from "./headers.js";

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

type ServerActionRedirectLocation = {
  href: string;
  internal: boolean;
};

/**
 * Resolve a server-action redirect target against the URL that initiated the
 * action. Dot-relative redirects intentionally resolve as if the current route
 * pathname were a directory, matching Next.js' `assignLocation()` behavior:
 * `./subpage` from `/subdir` lands on `/subdir/subpage`, not `/subpage`.
 */
export function resolveServerActionRedirectLocation(options: {
  currentHref: string;
  location: string;
  origin: string;
}): ServerActionRedirectLocation {
  const currentUrl = new URL(options.currentHref, options.origin);
  const redirectUrl = options.location.startsWith(".")
    ? new URL(
        options.location,
        `${currentUrl.origin}${currentUrl.pathname.endsWith("/") ? currentUrl.pathname : `${currentUrl.pathname}/`}`,
      )
    : new URL(options.location, currentUrl.href);

  return {
    href: redirectUrl.href,
    internal: redirectUrl.origin === currentUrl.origin,
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
