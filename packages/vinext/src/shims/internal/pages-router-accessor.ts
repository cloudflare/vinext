/**
 * Shared Pages Router navigation accessor.
 *
 * Both `next/navigation` (usePathname/useParams/useSearchParams) and the
 * internal `useUntrackedPathname` read from the same global Symbol. Keeping
 * the lookup in one place avoids the Symbol string and the error-handling
 * shape from drifting across modules.
 *
 * @internal
 */

export type PagesNavigationContext = {
  pathname: string | null;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]> | null;
};

const PAGES_NAVIGATION_ACCESSOR_KEY = Symbol.for(
  "vinext.navigation.pagesNavigationContextAccessor",
);

type _GlobalWithPagesAccessor = typeof globalThis & {
  [PAGES_NAVIGATION_ACCESSOR_KEY]?: () => PagesNavigationContext | null;
};

export function getPagesNavigationContext(): PagesNavigationContext | null {
  const accessor = (globalThis as _GlobalWithPagesAccessor)[PAGES_NAVIGATION_ACCESSOR_KEY];
  if (!accessor) return null;
  try {
    return accessor();
  } catch {
    return null;
  }
}
