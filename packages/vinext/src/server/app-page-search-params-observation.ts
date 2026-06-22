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
