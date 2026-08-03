/**
 * Lightweight bridge to the current Pages Router SSR context.
 *
 * The server-only router-state module registers an accessor backed by the
 * request-scoped AsyncLocalStorage state. The well-known symbol keeps the
 * bridge working when Vite evaluates `next/router` and `next/link` through
 * separate module instances during Pages SSR.
 */

export type PagesRouterSSRContext = {
  asPath: string;
  locales?: readonly string[];
};

const PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY = Symbol.for(
  "vinext.router.pagesRouterSSRContextAccessor",
);

type GlobalWithAccessor = typeof globalThis & {
  [PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY]?: () => PagesRouterSSRContext | null;
};

/** @internal */
export function registerPagesRouterSSRContextAccessor(
  accessor: () => PagesRouterSSRContext | null,
): () => void {
  const globalObject = globalThis as GlobalWithAccessor;
  const previous = globalObject[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY];
  globalObject[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY] = accessor;

  return () => {
    if (globalObject[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY] !== accessor) return;
    if (previous) {
      globalObject[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY] = previous;
    } else {
      delete globalObject[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY];
    }
  };
}

export function getPagesRouterSSRContext(): PagesRouterSSRContext | null {
  if (typeof window !== "undefined") return null;

  const accessor = (globalThis as GlobalWithAccessor)[PAGES_ROUTER_SSR_CONTEXT_ACCESSOR_KEY];
  if (!accessor) return null;

  try {
    return accessor();
  } catch {
    return null;
  }
}
