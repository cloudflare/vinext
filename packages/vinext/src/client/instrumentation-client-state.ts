import type { ClientInstrumentationHooks } from "./instrumentation-client.js";

// Pages Router dev pre-bundles next/* shims with their own copy of this module,
// while the browser entry registers hooks on the raw one. Keep the hooks on
// globalThis so every copy notifies the app's instrumentation-client.
const VINEXT_CLIENT_INSTRUMENTATION_HOOKS = Symbol.for("vinext.client.instrumentationHooks");

export function normalizeClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks,
): ClientInstrumentationHooks | null {
  return Object.values(hooks).some((value) => typeof value === "function") ? hooks : null;
}

export function setClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks | null,
): ClientInstrumentationHooks | null {
  Reflect.set(globalThis, VINEXT_CLIENT_INSTRUMENTATION_HOOKS, hooks);
  return hooks;
}

export function getClientInstrumentationHooks(): ClientInstrumentationHooks | null {
  return (
    (Reflect.get(globalThis, VINEXT_CLIENT_INSTRUMENTATION_HOOKS) as
      | ClientInstrumentationHooks
      | null
      | undefined) ?? null
  );
}

/**
 * Exported by the generated instrumentationClientInject module: whether any
 * module it fans out to has an onRouterTransitionStart hook right now.
 */
export const HAS_ROUTER_TRANSITION_START_EXPORT = "__vinextHasRouterTransitionStart";

/** Logged when one instrumentation-client module's router transition hook throws. */
export const INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE =
  "An instrumentation-client router transition hook failed";

export type RouterTransitionType = "push" | "replace" | "traverse";

/** How the `<Link>` that started a navigation prefetches: `prefetch={true}` is "full". */
export type RouterTransitionPrefetchIntent = "full" | "auto" | "none";

/** Next.js' `RouterTransitionStartEvent` (client/router-transition-types.ts). */
export type RouterTransitionStartEvent = {
  id: string;
  timestamp: number;
  /** Source route patterns of the page being left, its primary route first. */
  fromRoutes: string[];
  /** `null` when the navigation did not start from a `<Link>`. */
  prefetchIntent: RouterTransitionPrefetchIntent | null;
};

// The App Router browser entry registers how to read the committed route tree.
// It lives on globalThis for the same reason as the hooks above.
const VINEXT_ROUTER_TRANSITION_FROM_ROUTES = Symbol.for("vinext.client.routerTransitionFromRoutes");

export function setRouterTransitionFromRoutesResolver(resolve: (() => string[]) | null): void {
  Reflect.set(globalThis, VINEXT_ROUTER_TRANSITION_FROM_ROUTES, resolve);
}

function resolveRouterTransitionFromRoutes(): string[] {
  const resolve = Reflect.get(globalThis, VINEXT_ROUTER_TRANSITION_FROM_ROUTES) as
    | (() => string[])
    | null
    | undefined;
  return resolve ? resolve() : [];
}

let nextTransitionId = 0;

/**
 * Mirrors Next.js' `startRouterTransition`
 * (client/components/router-transition.ts). The third argument is `null`
 * unless `experimental.instrumentationClientRouterTransitionEvents` is set,
 * and a throwing hook is logged instead of breaking the navigation.
 */
export function notifyAppRouterTransitionStart(
  href: string,
  navigationType: RouterTransitionType,
  prefetchIntent: RouterTransitionPrefetchIntent | null = null,
): void {
  const hooks = getClientInstrumentationHooks();
  if (typeof hooks?.onRouterTransitionStart !== "function") return;
  // Next.js numbers a transition only when some module has a hook. The
  // inject fan-out is always a function, so it reports that itself.
  if (
    process.env.__NEXT_INSTRUMENTATION_CLIENT_ROUTER_TRANSITION_EVENTS &&
    hooks[HAS_ROUTER_TRANSITION_START_EXPORT]?.() === false
  ) {
    return;
  }
  // Positive flag check so the event path drops out of builds without the flag.
  const id = process.env.__NEXT_INSTRUMENTATION_CLIENT_ROUTER_TRANSITION_EVENTS
    ? `${Date.now().toString(36)}-${(++nextTransitionId).toString(36)}`
    : null;
  try {
    // Built inside the try like Next.js, so a failure is logged like a
    // throwing hook.
    const event: RouterTransitionStartEvent | null =
      id === null
        ? null
        : {
            id,
            timestamp: performance.timeOrigin + performance.now(),
            fromRoutes: resolveRouterTransitionFromRoutes(),
            prefetchIntent,
          };
    hooks.onRouterTransitionStart(href, navigationType, event);
  } catch (error) {
    console.error(INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE, error);
  }
}
