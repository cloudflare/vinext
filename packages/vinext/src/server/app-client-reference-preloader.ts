import { shareIsolatePromise } from "./isolate-shared-promise.js";

type ClientReferenceRequire = (id: string) => Promise<unknown>;

type ClientReferenceMap = Readonly<Record<string, unknown>>;

type ClientReferencePreloaderOptions = {
  getReferences: () => ClientReferenceMap | undefined;
  getClientRequire: () => ClientReferenceRequire | undefined;
  onPreloadError?: (id: string, error: unknown) => void;
};

type ClientReferencePreloader = {
  /**
   * Load `referenceIds`, or every reference without them, and also start the
   * loads of `streamedIds`, which the returned promise doesn't wait for.
   */
  preload: (referenceIds?: Iterable<string>, streamedIds?: Iterable<string>) => Promise<void>;
};

const resolvedPreload = Promise.resolve();

/** A promise carrying React's thenable status fields. */
type TrackedThenable = Promise<unknown> & {
  status?: "fulfilled" | "rejected";
  value?: unknown;
  reason?: unknown;
};

/**
 * The client references each App Router route preloads before SSR, generated
 * by plugins/rsc-client-reference-loaders.ts from the RSC build's module graph.
 * Each list holds indices into `references`, or for routes into `files`.
 */
export type RouteClientReferences = {
  /** Client reference keys. */
  references: readonly string[];
  /** References any render may use, whatever its route. */
  always: readonly number[];
  /** The references each route file reaches. */
  files: readonly (readonly number[])[];
  /** Each route pattern's files. */
  routes: Readonly<Record<string, readonly number[]>>;
  /** The files of a render without a route, such as a route-miss 404. */
  routeless: readonly number[];
  /**
   * References whose SSR modules evaluate asynchronously (top-level await),
   * which a render streams instead of waiting for.
   */
  async: readonly number[];
};

/** The client references a render loads before it starts, and those it streams. */
export type RouteClientReferenceSet = {
  awaited: string[];
  streamed: string[];
  /**
   * Both in import order: the `always` set, then each route file's references
   * in the order its route files render.
   */
  ordered: string[];
};

/**
 * The client references a render of `routePattern` preloads, or of no route
 * when it is null, split into those it waits for and those it streams.
 * Undefined, meaning every reference, without a plan or a route to look up,
 * or for a pattern the plan doesn't know.
 */
export function resolveRouteClientReferences(
  plan: RouteClientReferences | null,
  routePattern: string | null | undefined,
): RouteClientReferenceSet | undefined {
  if (!plan || routePattern === undefined) return undefined;
  let files: readonly number[];
  if (routePattern === null) {
    files = plan.routeless;
  } else if (Object.hasOwn(plan.routes, routePattern)) {
    files = plan.routes[routePattern]!;
  } else {
    return undefined;
  }
  const indices = new Set(plan.always);
  for (const file of files) {
    for (const index of plan.files[file]!) indices.add(index);
  }
  const asyncIndices = new Set(plan.async);
  const awaited: string[] = [];
  const streamed: string[] = [];
  const ordered: string[] = [];
  for (const index of indices) {
    const id = plan.references[index]!;
    (asyncIndices.has(index) ? streamed : awaited).push(id);
    ordered.push(id);
  }
  return { awaited, streamed, ordered };
}

export function createClientReferencePreloader(
  options: ClientReferencePreloaderOptions,
): ClientReferencePreloader {
  let allReferencesPreloaded = false;
  let allReferencesPreloadPromise: Promise<void> | null = null;
  const preloadedReferences = new Set<string>();
  const referencePreloadPromises = new Map<string, Promise<void>>();

  function preloadReference(id: string, clientRequire: ClientReferenceRequire): Promise<void> {
    const existing = referencePreloadPromises.get(id);
    if (existing) {
      return existing;
    }

    const loading: TrackedThenable = clientRequire(id);
    const preloadPromise = shareIsolatePromise(
      loading
        .then(
          (value) => {
            // React's Flight client waits a tick for a module whose promise
            // doesn't report itself settled, as React marks the promises it
            // has seen. Mark it the same way, so the first render after this
            // load resolves the module's elements as a warm render does.
            loading.status = "fulfilled";
            loading.value = value;
          },
          (error: unknown) => {
            loading.status = "rejected";
            loading.reason = error;
            throw error;
          },
        )
        .catch((error) => {
          options.onPreloadError?.(id, error);
        })
        .then(() => {
          preloadedReferences.add(id);
        })
        .finally(() => {
          referencePreloadPromises.delete(id);
        }),
    );

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
      // A warm render's references are all loaded: skip awaiting them.
      if (Object.hasOwn(refs, id) && !preloadedReferences.has(id)) {
        pending.push(preloadReference(id, clientRequire));
      }
    }

    if (pending.length === 0) {
      return resolvedPreload;
    }

    return Promise.all(pending).then(() => {});
  }

  return {
    preload(referenceIds, streamedIds) {
      const refs = options.getReferences();
      const clientRequire = options.getClientRequire();
      if (!refs || !clientRequire) {
        return resolvedPreload;
      }

      for (const id of streamedIds ?? []) {
        if (Object.hasOwn(refs, id) && !preloadedReferences.has(id)) {
          void preloadReference(id, clientRequire);
        }
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

      allReferencesPreloadPromise = shareIsolatePromise(
        preloadReferenceSet(Object.keys(refs), refs, clientRequire)
          .then(() => {
            allReferencesPreloaded = true;
          })
          .finally(() => {
            allReferencesPreloadPromise = null;
          }),
      );

      return allReferencesPreloadPromise;
    },
  };
}
