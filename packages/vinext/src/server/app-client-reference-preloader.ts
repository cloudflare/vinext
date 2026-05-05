type ClientReferenceRequire = (id: string) => Promise<unknown>;

type ClientReferenceMap = Readonly<Record<string, unknown>>;

type ClientReferencePreloaderOptions = {
  getReferences: () => ClientReferenceMap | undefined;
  getClientRequire: () => ClientReferenceRequire | undefined;
  onPreloadError?: (id: string, error: unknown) => void;
};

type ClientReferencePreloader = {
  preload: (referenceIds?: Iterable<string>) => Promise<void>;
};

const resolvedPreload = Promise.resolve();

export function createClientReferencePreloader(
  options: ClientReferencePreloaderOptions,
): ClientReferencePreloader {
  let allReferencesPreloaded = false;
  let allReferencesPreloadPromise: Promise<void> | null = null;
  const preloadedReferences = new Set<string>();
  const referencePreloadPromises = new Map<string, Promise<void>>();

  function preloadReference(id: string, clientRequire: ClientReferenceRequire): Promise<void> {
    if (preloadedReferences.has(id)) {
      return resolvedPreload;
    }

    const existing = referencePreloadPromises.get(id);
    if (existing) {
      return existing;
    }

    const preloadPromise = clientRequire(id)
      .catch((error) => {
        options.onPreloadError?.(id, error);
      })
      .then(() => {
        preloadedReferences.add(id);
      })
      .finally(() => {
        referencePreloadPromises.delete(id);
      });

    referencePreloadPromises.set(id, preloadPromise);
    return preloadPromise;
  }

  function preloadReferenceSet(
    referenceIds: Iterable<string>,
    refs: ClientReferenceMap,
    clientRequire: ClientReferenceRequire,
  ): Promise<void> {
    const pending: Promise<void>[] = [];

    for (const id of referenceIds) {
      if (Object.hasOwn(refs, id)) {
        pending.push(preloadReference(id, clientRequire));
      }
    }

    if (pending.length === 0) {
      return resolvedPreload;
    }

    return Promise.all(pending).then(() => {});
  }

  return {
    preload(referenceIds) {
      const refs = options.getReferences();
      const clientRequire = options.getClientRequire();
      if (!refs || !clientRequire) {
        return resolvedPreload;
      }

      if (referenceIds) {
        return preloadReferenceSet(referenceIds, refs, clientRequire);
      }

      if (allReferencesPreloaded) {
        return resolvedPreload;
      }
      if (allReferencesPreloadPromise) {
        return allReferencesPreloadPromise;
      }

      allReferencesPreloadPromise = preloadReferenceSet(Object.keys(refs), refs, clientRequire)
        .then(() => {
          allReferencesPreloaded = true;
        })
        .finally(() => {
          allReferencesPreloadPromise = null;
        });

      return allReferencesPreloadPromise;
    },
  };
}
