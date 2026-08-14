const VINEXT_CLIENT_REACT = Symbol.for("vinext.client.react");

/**
 * Return the React instance registered by the vinext browser entry.
 *
 * Module Federation remotes can call this with their local React namespace to
 * reuse the host instance. The first browser registration wins so evaluating
 * another copy of this module (for example after HMR) cannot replace it.
 * Server and RSC environments always keep their condition-specific React
 * instance local.
 */
export function getVinextReact(reactInstance: typeof import("react")): typeof import("react") {
  if (typeof window === "undefined") {
    return reactInstance;
  }

  const registeredReact = Reflect.get(globalThis, VINEXT_CLIENT_REACT) as
    | typeof import("react")
    | undefined;
  if (registeredReact !== undefined) {
    return registeredReact;
  }

  Reflect.set(globalThis, VINEXT_CLIENT_REACT, reactInstance);
  return reactInstance;
}
