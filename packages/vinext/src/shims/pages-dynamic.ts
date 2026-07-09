/**
 * Client-safe registration surface for request-scoped Pages Router
 * next/dynamic module usage.
 */
let recordModuleIds = (_moduleIds: readonly string[] | undefined): void => {};
let readModuleIds = (): string[] | undefined => undefined;
const clientInitializers = new Set<
  (requestedIds: ReadonlySet<string>) => Promise<unknown> | undefined
>();
let clientPreloadFinished = false;
let clientPreloadPromise: Promise<void> | undefined;

export function _registerPagesDynamicStateAccessors(accessors: {
  recordPagesDynamicModuleIds: (moduleIds: readonly string[] | undefined) => void;
  getPagesDynamicModuleIds: () => string[] | undefined;
}): void {
  recordModuleIds = accessors.recordPagesDynamicModuleIds;
  readModuleIds = accessors.getPagesDynamicModuleIds;
}

export function recordPagesDynamicModuleIds(moduleIds: readonly string[] | undefined): void {
  recordModuleIds(moduleIds);
}

export function getPagesDynamicModuleIds(): string[] | undefined {
  return readModuleIds();
}

export function registerPagesDynamicInitializer(
  moduleIds: readonly string[] | undefined,
  initializer: () => Promise<unknown>,
): void {
  if (typeof window === "undefined" || clientPreloadFinished || !moduleIds) return;
  const registeredIds = new Set(moduleIds);
  clientInitializers.add((requestedIds) => {
    for (const moduleId of registeredIds) {
      if (requestedIds.has(moduleId)) return initializer();
    }
  });
}

export async function preloadPagesDynamicModules(
  moduleIds: readonly (string | number)[] = [],
): Promise<void> {
  if (clientPreloadPromise) return clientPreloadPromise;

  const requestedIds = new Set(moduleIds.map(String));
  clientPreloadPromise = (async (): Promise<void> => {
    do {
      const initializers = Array.from(clientInitializers);
      clientInitializers.clear();
      const pending = initializers
        .map((initializer) => initializer(requestedIds))
        .filter((promise): promise is Promise<unknown> => promise !== undefined);
      await Promise.all(pending.map((promise) => promise.catch(() => undefined)));
    } while (clientInitializers.size > 0);
    clientPreloadFinished = true;
  })();
  return clientPreloadPromise;
}

if (typeof window !== "undefined") {
  window.__NEXT_PRELOADREADY = preloadPagesDynamicModules;
}
