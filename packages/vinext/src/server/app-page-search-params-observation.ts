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
import {
  createPartialRscShellRequestApiSuspensePromise,
  isPartialRscShellRequestApiScopeActive,
} from "vinext/shims/partial-rsc-shell-request-api";
import type { AppPageSearchParams } from "./app-page-head.js";

type AppPageSearchParamsObservationOptions = {
  markDynamic?: boolean;
  observeReactPromiseStatus?: boolean;
};

function markAppPageSearchParamsAccess(keys: readonly string[], markDynamic: boolean): void {
  // React Flight dev/debug serialization can attach to a thenable and observe
  // "all keys" even when the page never read searchParams. For a concrete URL
  // with no search keys, that introspection must not make a complete static
  // navigation shell look partial.
  if (keys.length === 0 && isPartialRscShellRequestApiScopeActive()) {
    return;
  }
  throwIfStaticGenerationAccessError();
  throwIfInsideCacheScope("searchParams");
  const shellSuspense =
    createPartialRscShellRequestApiSuspensePromise<AppPageSearchParams>("searchParams");
  if (shellSuspense !== null) {
    throw shellSuspense;
  }
  if (markDynamic) {
    markDynamicUsage();
  }
  markRenderRequestApiUsage("searchParams");
}

export function createAppPageSearchParamsObserver(
  options: AppPageSearchParamsObservationOptions = {},
): ThenableParamsObserver {
  return {
    observeParamAccess(keys: readonly string[]) {
      markAppPageSearchParamsAccess(keys, options.markDynamic !== false);
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
