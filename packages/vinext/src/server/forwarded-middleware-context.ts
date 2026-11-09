import { safeEqual } from "./revalidation-request.js";

/**
 * Hybrid app+pages dev runs middleware once in the Pages connect handler and
 * forwards the result to the App Router in x-vinext-mw-ctx. The value is
 * prefixed with a per-dev-server key that only vinext's generated RSC entry
 * knows, so a client-supplied copy can never stand in for running middleware,
 * whichever plugin builds the App Router request first.
 */
const KEY_SEPARATOR = ".";

export function sealForwardedMiddlewareContext(key: string, context: string): string {
  return key + KEY_SEPARATOR + context;
}

/** Returns the forwarded context JSON, or null unless it carries `key`. */
export function openForwardedMiddlewareContext(
  value: string | null,
  key: string | null | undefined,
): string | null {
  if (value === null || !key) return null;
  const separatorIndex = value.indexOf(KEY_SEPARATOR);
  if (separatorIndex === -1 || !safeEqual(value.slice(0, separatorIndex), key)) return null;
  return value.slice(separatorIndex + 1);
}
