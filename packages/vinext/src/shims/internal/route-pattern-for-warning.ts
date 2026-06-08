/**
 * Side-effect-free accessor for the current render's route pattern, used by
 * Next.js-parity diagnostics such as the Link shim's
 * "Invalid href ... in page: '...'" `console.error`.
 *
 * Mirrors Next.js's `router.pathname`, which is the *route pattern* (e.g.
 * `/posts/[id]`), not the resolved URL. During Pages Router SSR the route
 * pattern lives on the request-scoped SSR context; the server-only
 * `router-state.ts` publishes an accessor for it under a well-known
 * `Symbol.for` handle. We read it through that handle rather than importing
 * `router.ts` directly — importing `router.ts` would pull its browser-only
 * `installWindowNext()` side effect into every consumer of the Link shim
 * (including the App Router client bundle), clobbering `window.next.router`.
 *
 * On the client (or when no accessor is registered, e.g. App Router) we fall
 * back to `window.location.pathname`, then to `"/"`.
 */

const ROUTE_PATTERN_FOR_WARNING_ACCESSOR_KEY = Symbol.for(
  "vinext.router.routePatternForWarningAccessor",
);

type GlobalWithAccessor = typeof globalThis & {
  [ROUTE_PATTERN_FOR_WARNING_ACCESSOR_KEY]?: () => string | null;
};

/**
 * Register the server-side route-pattern accessor. Called once by the
 * server-only router-state module on import. Idempotent.
 * @internal
 */
export function registerRoutePatternForWarningAccessor(accessor: () => string | null): void {
  (globalThis as GlobalWithAccessor)[ROUTE_PATTERN_FOR_WARNING_ACCESSOR_KEY] = accessor;
}

export function getCurrentRoutePathnameForWarning(): string {
  if (typeof window === "undefined") {
    const accessor = (globalThis as GlobalWithAccessor)[ROUTE_PATTERN_FOR_WARNING_ACCESSOR_KEY];
    if (accessor) {
      try {
        const pattern = accessor();
        if (pattern) return pattern;
      } catch {
        // Fall through to the default below.
      }
    }
    return "/";
  }
  return window.location?.pathname ?? "/";
}
