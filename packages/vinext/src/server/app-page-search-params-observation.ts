import {
  markDynamicUsage,
  markRenderRequestApiUsage,
  throwIfInsideCacheScope,
} from "vinext/shims/headers";
import { makeThenableParams, type ThenableParams } from "vinext/shims/thenable-params";
import type { AppPageSearchParams } from "./app-page-head.js";

type AppPageSearchParamsObservationOptions = {
  observeReactPromiseStatus?: boolean;
};

function markAppPageSearchParamsAccess(): void {
  throwIfInsideCacheScope("searchParams");
  markDynamicUsage();
  markRenderRequestApiUsage("searchParams");
}

export function makeObservedAppPageSearchParamsThenable(
  pageSearchParams: AppPageSearchParams,
  options: AppPageSearchParamsObservationOptions = {},
): ThenableParams<AppPageSearchParams> {
  const observer = {
    observeParamAccess() {
      markAppPageSearchParamsAccess();
    },
  };
  if (options.observeReactPromiseStatus === true) {
    return makeThenableParams(pageSearchParams, {
      ...observer,
      observeReactPromiseStatus: true,
    });
  }
  return makeThenableParams(pageSearchParams, observer);
}
