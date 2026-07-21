import { INITIAL_BFCACHE_ID } from "./app-bfcache-id.js";
import { assertSafeNavigationUrl } from "vinext/shims/url-safety";
import type { AppRouterInstance, NavigateOptions } from "vinext/shims/internal/app-router-context";

function validateNavigationHref(href: string): void {
  assertSafeNavigationUrl(href);
}

export const ssrAppRouterInstance: AppRouterInstance = {
  bfcacheId: INITIAL_BFCACHE_ID,
  back() {},
  forward() {},
  refresh() {},
  push(href: string, _options?: NavigateOptions) {
    validateNavigationHref(href);
  },
  replace(href: string, _options?: NavigateOptions) {
    validateNavigationHref(href);
  },
  prefetch(href: string) {
    validateNavigationHref(href);
  },
};

if (process.env.__NEXT_GESTURE_TRANSITION) {
  ssrAppRouterInstance.experimental_gesturePush = validateNavigationHref;
}
