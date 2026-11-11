import {
  markDynamicUsage,
  markRenderRequestApiUsage,
  throwIfInsideCacheScope,
  throwIfStaticGenerationAccessError,
} from "vinext/shims/internal/headers-state";
import {
  makeThenableParams,
  type ThenableParams,
  type ThenableParamsObserver,
} from "vinext/shims/thenable-params";
import type { SearchParamsGate } from "vinext/shims/search-params-gate";
import type { AppPageSearchParams } from "./app-page-head.js";
import { searchParamsToRecord } from "../utils/query.js";

type ClientPageSsrSearchParamsOptions = {
  isForceStatic?: boolean;
  isPprFallbackShell?: boolean;
  /**
   * The render's SSR `useSearchParams()` gate, which a client page's
   * `searchParams` wait on with Cache Components.
   */
  searchParamsGate?: SearchParamsGate;
  /** Runs when the gate bails out a client page's `searchParams`, which hang. */
  onSearchParamsHang?: () => void;
};

function markAppPageSearchParamsAccess(): void {
  throwIfStaticGenerationAccessError();
  throwIfInsideCacheScope("searchParams");
  markDynamicUsage();
  markRenderRequestApiUsage("searchParams");
}

function createAppPageSearchParamsObserver(): ThenableParamsObserver {
  return {
    observeParamAccess() {
      markAppPageSearchParamsAccess();
    },
    // Like Next.js, dynamic = "error" fails a read of `searchParams.then`, so
    // passing searchParams to a client component fails the render.
    observeThenRead: throwIfStaticGenerationAccessError,
  };
}

/**
 * The observer a route's head hands generateMetadata() and generateViewport()
 * for `searchParams`, or none when a read doesn't count (`force-static`).
 */
export function createAppPageMetadataSearchParamsObserver(
  observe: boolean,
): ThenableParamsObserver | undefined {
  return observe ? createAppPageSearchParamsObserver() : undefined;
}

export function makeObservedAppPageSearchParamsThenable(
  pageSearchParams: AppPageSearchParams,
): ThenableParams<AppPageSearchParams> {
  return makeThenableParams(pageSearchParams, createAppPageSearchParamsObserver(), {
    isSearchParams: true,
  });
}

/**
 * The `searchParams` a client page receives during SSR (see
 * `shims/client-page-root.tsx`). Its RSC payload carries no query, so this is
 * the only place a client page can read it on the server, and a read counts
 * like a server page's: the render is dynamic and won't be stored.
 *
 * `force-static` renders read an empty query, which isn't a read, and PPR
 * fallback shells keep their untracked query, so neither is observed.
 */
export function makeClientPageSsrSearchParamsThenable(
  searchParams: URLSearchParams,
  options: ClientPageSsrSearchParamsOptions,
): ThenableParams<AppPageSearchParams> {
  return makeClientPageSsrSearchParamsThenableFromRecord(
    searchParamsToRecord(searchParams),
    options,
  );
}

/**
 * The client page `searchParams` of one SSR render, one promise per page,
 * keyed by the page's props object as the browser keys its own. React writes
 * `status` and `value` onto a promise it tracks, so a promise shared across
 * pages would show one page's `use()` to a sibling in SSR only.
 *
 * The cache lives in this render's navigation context and is dropped with it.
 */
export function createClientPageSsrSearchParamsSource(
  searchParams: URLSearchParams,
  options: ClientPageSsrSearchParamsOptions,
): (pageProps: object) => ThenableParams<AppPageSearchParams> {
  const pageSearchParams = searchParamsToRecord(searchParams);
  const byPage = new WeakMap<object, ThenableParams<AppPageSearchParams>>();
  return (pageProps) => {
    let thenable = byPage.get(pageProps);
    if (!thenable) {
      thenable = makeClientPageSsrSearchParamsThenableFromRecord(pageSearchParams, options);
      byPage.set(pageProps, thenable);
    }
    return thenable;
  };
}

function makeClientPageSsrSearchParamsThenableFromRecord(
  pageSearchParams: AppPageSearchParams,
  options: ClientPageSsrSearchParamsOptions,
): ThenableParams<AppPageSearchParams> {
  if (options.isForceStatic === true || options.isPprFallbackShell === true) {
    return makeThenableParams(pageSearchParams, undefined, { isSearchParams: true });
  }
  if (!options.searchParamsGate) return makeObservedAppPageSearchParamsThenable(pageSearchParams);
  return makeThenableParams(
    pageSearchParams,
    createGatedClientPageSearchParamsObserver(options.searchParamsGate, options.onSearchParamsHang),
    { isSearchParams: true },
  );
}

/**
 * With Cache Components, Next.js's prerender hands a client page `searchParams`
 * that never resolve (`createSearchParamsFromClient`), and a route whose server
 * render is static is stored with the page's Suspense boundary rendering in
 * the browser (app-render.tsx). So awaiting them waits for the render's
 * `useSearchParams()` gate: once the render is dynamic they resolve to the
 * query, and the read counts as usual; once it settles static, they never
 * settle, so the page can't catch the bail-out, and the render is aborted
 * (`onHang`), which renders the nearest Suspense boundary in the browser.
 * Reading a key synchronously still reads the query at once and marks the
 * render dynamic.
 */
function createGatedClientPageSearchParamsObserver(
  gate: SearchParamsGate,
  onHang: (() => void) | undefined,
): ThenableParamsObserver {
  // Created on the first continuation, so a page that never awaits them
  // registers no hang.
  let gated: Promise<unknown> | null = null;
  return {
    ...createAppPageSearchParamsObserver(),
    deferContinuation(continueWith) {
      gated ??= gate.decided.then(() => {
        if (gate.decision === "bailout") {
          onHang?.();
          return new Promise<never>(() => {});
        }
        return continueWith();
      });
      return gated;
    },
  };
}
