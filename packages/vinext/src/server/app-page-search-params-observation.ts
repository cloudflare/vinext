import {
  markDynamicUsage,
  markRenderRequestApiUsage,
  throwIfInsideCacheScope,
  throwIfStaticGenerationAccessError,
} from "vinext/shims/headers";
import {
  makeThenableParams,
  type ThenableParams,
  type ThenableParamsObserver,
} from "vinext/shims/thenable-params";
import type { AppPageSearchParams } from "./app-page-head.js";
import { searchParamsToRecord } from "../utils/query.js";

type AppPageSearchParamsObservationOptions = {
  observeReactPromiseStatus?: boolean;
};

function markAppPageSearchParamsAccess(): void {
  throwIfStaticGenerationAccessError();
  throwIfInsideCacheScope("searchParams");
  markDynamicUsage();
  markRenderRequestApiUsage("searchParams");
}

export function createAppPageSearchParamsObserver(): ThenableParamsObserver {
  return {
    observeParamAccess() {
      markAppPageSearchParamsAccess();
    },
  };
}

export function makeObservedAppPageSearchParamsThenable(
  pageSearchParams: AppPageSearchParams,
  options: AppPageSearchParamsObservationOptions = {},
): ThenableParams<AppPageSearchParams> {
  const observer = createAppPageSearchParamsObserver();
  if (options.observeReactPromiseStatus === true) {
    return makeThenableParams(pageSearchParams, {
      ...observer,
      observeReactPromiseStatus: true,
    });
  }
  return makeThenableParams(pageSearchParams, observer);
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
  options: { isForceStatic?: boolean; isPprFallbackShell?: boolean },
): ThenableParams<AppPageSearchParams> {
  const pageSearchParams = searchParamsToRecord(searchParams);
  return options.isForceStatic !== true && options.isPprFallbackShell !== true
    ? makeObservedAppPageSearchParamsThenable(pageSearchParams)
    : makeThenableParams(pageSearchParams);
}
