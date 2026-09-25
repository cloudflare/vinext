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
  markDynamic?: boolean;
  observeReactPromiseStatus?: boolean;
};

function markAppPageSearchParamsAccess(markDynamic: boolean): void {
  throwIfStaticGenerationAccessError();
  throwIfInsideCacheScope("searchParams");
  if (markDynamic) {
    markDynamicUsage();
  }
  markRenderRequestApiUsage("searchParams");
}

export function createAppPageSearchParamsObserver(
  options: AppPageSearchParamsObservationOptions = {},
): ThenableParamsObserver {
  return {
    observeParamAccess() {
      markAppPageSearchParamsAccess(options.markDynamic !== false);
    },
  };
}

export function makeObservedAppPageSearchParamsThenable(
  pageSearchParams: AppPageSearchParams,
  options: AppPageSearchParamsObservationOptions = {},
): ThenableParams<AppPageSearchParams> {
  const observer = createAppPageSearchParamsObserver(options);
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
 * like a server page's: the render is dynamic and won't be stored. With
 * `observe` false the query is handed over without tracking.
 */
export function makeClientPageSsrSearchParamsThenable(
  searchParams: URLSearchParams,
  options: { observe: boolean },
): ThenableParams<AppPageSearchParams> {
  const pageSearchParams = searchParamsToRecord(searchParams);
  return options.observe
    ? makeObservedAppPageSearchParamsThenable(pageSearchParams)
    : makeThenableParams(pageSearchParams);
}
