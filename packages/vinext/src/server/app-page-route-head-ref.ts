import { getRequestContext, isInsideUnifiedScope } from "vinext/shims/unified-request-context";

/**
 * How a head component's props name the function that resolves the page's
 * head: an id in the current request, or the function outside a request.
 *
 * In development, React's Node Flight server keeps a record of each promise a
 * component creates, holding the component's props, until the promise is
 * collected. A function in the props that can reach the head's promises would
 * keep them, and through them the whole render, alive for the rest of the
 * process. Next.js's metadata components don't take one either.
 */
export type AppPageRouteHeadRef<T> = string | (() => T);

let lastRouteHeadId = 0;

export function createAppPageRouteHeadRef<T>(resolveHead: () => T): AppPageRouteHeadRef<T> {
  // Outside a request there's no store that ends with it.
  if (!isInsideUnifiedScope()) return resolveHead;
  const id = String(++lastRouteHeadId);
  getRequestContext().appPageRouteHeads.set(id, resolveHead);
  return id;
}

export function resolveAppPageRouteHeadRef<T>(ref: AppPageRouteHeadRef<T>): T {
  if (typeof ref === "function") return ref();
  const resolveHead = getRequestContext().appPageRouteHeads.get(ref);
  if (!resolveHead) {
    throw new Error(`[vinext] Page head ${ref} was rendered outside the request that built it.`);
  }
  return resolveHead() as T;
}
