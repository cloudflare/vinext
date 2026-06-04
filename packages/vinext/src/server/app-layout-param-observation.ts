import type { ThenableParamsObserver } from "vinext/shims/thenable-params";
import {
  _peekRequestScopedCacheLife,
  _peekUnstableCacheObservations,
  type UnstableCacheObservation,
} from "vinext/shims/cache";
import {
  getCollectedFetchTags,
  peekCacheableFetchObservations,
  peekDynamicFetchObservations,
} from "vinext/shims/fetch-cache";
import { peekDynamicUsage, peekRenderRequestApiUsage } from "vinext/shims/headers";
import {
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "vinext/shims/unified-request-context";
import type { RenderRequestApiKind } from "./cache-proof.js";

export type AppLayoutParamAccessObservation = Readonly<{
  cacheLifeObserved: boolean;
  cacheTags: readonly string[];
  cacheableFetchCount: number;
  completeness: "complete" | "unknown";
  dynamicFetchCount: number;
  /**
   * `markDynamicUsage()` fired during the probe (e.g. `"use cache: private"`,
   * `connection()`) with no other observable trace. Folded in from the
   * isolated probe scope so this signal can't diverge from the Layer-3
   * `dynamicDetected` path it replaced.
   */
  dynamicUsageObserved: boolean;
  finiteRevalidateSeconds: number | null;
  keys: readonly string[];
  observed: boolean;
  paramScopeKeys: readonly string[];
  requestApis: readonly RenderRequestApiKind[];
  unstableCaches: readonly UnstableCacheObservation[];
}>;

export type AppLayoutParamAccessTracker = Readonly<{
  createThenableParamsObserver: (layoutId: string) => ThenableParamsObserver;
  getLayoutObservation: (layoutId: string) => AppLayoutParamAccessObservation;
  recordLayoutFiniteRevalidate: (layoutId: string, revalidateSeconds: number) => void;
  recordLayoutParamScope: (layoutId: string, paramScopeKeys: readonly string[]) => void;
  runLayoutProbe: (layoutId: string, probe: () => unknown) => unknown;
}>;

export function isAppLayoutObservationUnsafeForStaticReuse(
  observation: AppLayoutParamAccessObservation,
): boolean {
  return (
    observation.completeness !== "complete" ||
    observation.paramScopeKeys.length > 0 ||
    observation.observed ||
    observation.dynamicUsageObserved ||
    observation.requestApis.length > 0 ||
    observation.finiteRevalidateSeconds !== null ||
    observation.cacheLifeObserved ||
    observation.cacheTags.length > 0 ||
    observation.cacheableFetchCount > 0 ||
    observation.dynamicFetchCount > 0 ||
    observation.unstableCaches.length > 0
  );
}

type MutableLayoutParamAccessObservation = {
  cacheLifeObserved: boolean;
  cacheTags: Set<string>;
  cacheableFetches: Set<string>;
  dynamicFetches: Set<string>;
  dynamicUsageObserved: boolean;
  finiteRevalidateSeconds: number | null;
  keys: Set<string>;
  observed: boolean;
  paramScopeKeys: Set<string>;
  probeComplete: boolean;
  requestApis: Set<RenderRequestApiKind>;
  unstableCaches: Map<string, UnstableCacheObservation>;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

export function createAppLayoutParamAccessTracker(): AppLayoutParamAccessTracker {
  const observations = new Map<string, MutableLayoutParamAccessObservation>();

  const ensureObservation = (layoutId: string): MutableLayoutParamAccessObservation => {
    const existing = observations.get(layoutId);
    if (existing) return existing;

    const created: MutableLayoutParamAccessObservation = {
      cacheLifeObserved: false,
      cacheTags: new Set(),
      cacheableFetches: new Set(),
      dynamicFetches: new Set(),
      dynamicUsageObserved: false,
      finiteRevalidateSeconds: null,
      keys: new Set(),
      observed: false,
      paramScopeKeys: new Set(),
      probeComplete: false,
      requestApis: new Set(),
      unstableCaches: new Map(),
    };
    observations.set(layoutId, created);
    return created;
  };

  const markObserved = (layoutId: string, keys: readonly string[]) => {
    const observation = ensureObservation(layoutId);
    observation.observed = true;
    for (const key of keys) {
      observation.keys.add(key);
    }
  };

  const markProbeComplete = (layoutId: string) => {
    ensureObservation(layoutId).probeComplete = true;
  };

  const runWithIsolatedProbeDependencies = (probe: () => unknown): unknown => {
    if (!isInsideUnifiedScope()) {
      return probe();
    }
    return runWithUnifiedStateMutation((ctx) => {
      ctx.cacheableFetchUrls = new Set();
      ctx.currentRequestTags = [];
      ctx.currentFetchSoftTags = [];
      ctx.dynamicFetchUrls = new Set();
      ctx.dynamicUsageDetected = false;
      ctx.renderRequestApiUsage = new Set();
      ctx.requestScopedCacheLife = null;
      ctx.unstableCacheObservations = new Map();
    }, probe);
  };

  const recordProbeDependencies = (layoutId: string) => {
    const observation = ensureObservation(layoutId);
    // Capture the probe's child-scope dynamic-usage flag before the isolated
    // scope is discarded. `markDynamicUsage()` calls that leave no other
    // observable trace (e.g. `"use cache: private"`) would otherwise be lost
    // when the child scope resets `dynamicUsageDetected`, masking the Layer-3
    // `dynamicDetected` signal this probe wiring replaced.
    if (peekDynamicUsage()) {
      observation.dynamicUsageObserved = true;
    }
    if (_peekRequestScopedCacheLife() !== null) {
      observation.cacheLifeObserved = true;
    }
    for (const tag of getCollectedFetchTags()) {
      observation.cacheTags.add(tag);
    }
    for (const url of peekCacheableFetchObservations()) {
      observation.cacheableFetches.add(url);
    }
    for (const url of peekDynamicFetchObservations()) {
      observation.dynamicFetches.add(url);
    }
    for (const requestApi of peekRenderRequestApiUsage()) {
      observation.requestApis.add(requestApi);
    }
    for (const unstableCache of _peekUnstableCacheObservations()) {
      observation.unstableCaches.set(unstableCache.keyHash, unstableCache);
    }
  };

  return {
    createThenableParamsObserver(layoutId) {
      return {
        observeParamAccess(keys) {
          markObserved(layoutId, keys);
        },
      };
    },
    getLayoutObservation(layoutId) {
      const observation = observations.get(layoutId);
      if (!observation) {
        return {
          cacheLifeObserved: false,
          cacheTags: [],
          cacheableFetchCount: 0,
          completeness: "unknown",
          dynamicFetchCount: 0,
          dynamicUsageObserved: false,
          finiteRevalidateSeconds: null,
          keys: [],
          observed: false,
          paramScopeKeys: [],
          requestApis: [],
          unstableCaches: [],
        };
      }

      return {
        cacheLifeObserved: observation.cacheLifeObserved,
        cacheTags: [...observation.cacheTags].sort(),
        cacheableFetchCount: observation.cacheableFetches.size,
        completeness: observation.probeComplete ? "complete" : "unknown",
        dynamicFetchCount: observation.dynamicFetches.size,
        dynamicUsageObserved: observation.dynamicUsageObserved,
        finiteRevalidateSeconds: observation.finiteRevalidateSeconds,
        keys: [...observation.keys].sort(),
        observed: observation.observed,
        paramScopeKeys: [...observation.paramScopeKeys].sort(),
        requestApis: [...observation.requestApis].sort(),
        unstableCaches: [...observation.unstableCaches.values()].sort((a, b) =>
          a.keyHash.localeCompare(b.keyHash),
        ),
      };
    },
    recordLayoutFiniteRevalidate(layoutId, revalidateSeconds) {
      if (!Number.isFinite(revalidateSeconds) || revalidateSeconds <= 0) return;
      const observation = ensureObservation(layoutId);
      observation.finiteRevalidateSeconds =
        observation.finiteRevalidateSeconds === null
          ? revalidateSeconds
          : Math.min(observation.finiteRevalidateSeconds, revalidateSeconds);
    },
    recordLayoutParamScope(layoutId, paramScopeKeys) {
      const observation = ensureObservation(layoutId);
      for (const key of paramScopeKeys) {
        observation.paramScopeKeys.add(key);
      }
    },
    runLayoutProbe(layoutId, probe) {
      return runWithIsolatedProbeDependencies(() => {
        const result = probe();
        if (!isPromiseLike(result)) {
          recordProbeDependencies(layoutId);
          markProbeComplete(layoutId);
          return result;
        }

        return Promise.resolve(result).then(
          (resolved) => {
            recordProbeDependencies(layoutId);
            markProbeComplete(layoutId);
            return resolved;
          },
          (error: unknown) => {
            // Record whatever dependencies we observed before the failure
            // so the layout's dependency snapshot is as complete as possible.
            // Deliberately do NOT call markProbeComplete here: a failed probe
            // leaves completeness as "unknown", which makes the planner fall
            // back to render-and-send — the safe default for any probe error.
            recordProbeDependencies(layoutId);
            throw error;
          },
        );
      });
    },
  };
}
