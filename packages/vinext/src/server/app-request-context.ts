import { setHeadersContext } from "vinext/shims/headers";
import {
  setNavigationContext as setNavigationContextOrig,
  type NavigationContext,
} from "vinext/shims/navigation";
import { setRootParams } from "vinext/shims/root-params";

/**
 * Set navigation context in the ALS-backed store. "use client" components
 * rendered during SSR need the pathname/searchParams/params but the SSR
 * environment has a separate module instance of next/navigation.
 *
 * Clearing nav context (ctx === null) also clears root params.
 */
export function setAppNavigationContext(ctx: NavigationContext | null): void {
  setNavigationContextOrig(ctx);
  if (ctx === null) setRootParams(null);
}

/**
 * Clear all per-request ALS state owned by the App Router handler.
 * Must be called before returning a non-page response (redirect, public
 * file proxy, etc.) to prevent state leaking between requests on Workers.
 *
 * Clears: headers, navigation context, root params.
 */
export function clearAppRequestContext(): void {
  setHeadersContext(null);
  setAppNavigationContext(null);
}
