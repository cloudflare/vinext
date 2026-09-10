import { getRequestExecutionContext } from "../request-context.js";

const PENDING_CACHE_REVALIDATIONS = Symbol.for("vinext.cache.pendingRevalidations");
const CACHE_WRITE_COORDINATORS = Symbol.for("vinext.cache.writeCoordinators");
const globalState = globalThis as unknown as Record<PropertyKey, unknown>;

export type CacheRevalidationLease = {
  write: (key: string, write: () => Promise<void>) => Promise<void>;
};

type CacheRevalidation = {
  active: boolean;
  background: boolean;
  generation: number;
  promise: Promise<unknown>;
};

type CacheRevalidationCoordinator = {
  active: number;
  current: CacheRevalidation;
};

type CacheWriteClaim = {
  current: CacheRevalidation;
  committed: (() => Promise<void>) | undefined;
};

type CacheWriteCoordinator = {
  active: number;
  generation: number;
  claims: Map<string, CacheWriteClaim>;
};

function getPendingCacheRevalidations(): Map<string, CacheRevalidationCoordinator> {
  const existing = globalState[PENDING_CACHE_REVALIDATIONS];
  if (existing instanceof Map) return existing;

  const pending = new Map<string, CacheRevalidationCoordinator>();
  globalState[PENDING_CACHE_REVALIDATIONS] = pending;
  return pending;
}

function getCacheWriteCoordinators(): Map<string, CacheWriteCoordinator> {
  const existing = globalState[CACHE_WRITE_COORDINATORS];
  if (existing instanceof Map) return existing;

  const coordinators = new Map<string, CacheWriteCoordinator>();
  globalState[CACHE_WRITE_COORDINATORS] = coordinators;
  return coordinators;
}

function startCacheRevalidation(
  background: boolean,
  writeFamily: string,
): { revalidation: CacheRevalidation; writeCoordinator: CacheWriteCoordinator } {
  const coordinators = getCacheWriteCoordinators();
  const writeCoordinator = coordinators.get(writeFamily) ?? {
    active: 0,
    generation: 0,
    claims: new Map(),
  };
  writeCoordinator.active += 1;
  const revalidation: CacheRevalidation = {
    active: true,
    background,
    generation: ++writeCoordinator.generation,
    promise: Promise.resolve(),
  };
  coordinators.set(writeFamily, writeCoordinator);
  return { revalidation, writeCoordinator };
}

function finishCacheRevalidation(writeFamily: string, coordinator: CacheWriteCoordinator): void {
  coordinator.active -= 1;
  if (coordinator.active === 0 && getCacheWriteCoordinators().get(writeFamily) === coordinator) {
    getCacheWriteCoordinators().delete(writeFamily);
  }
}

export function hasPendingCacheWrites(writeFamily: string): boolean {
  return (getCacheWriteCoordinators().get(writeFamily)?.active ?? 0) > 0;
}

/** Run one foreground fill and supersede any older background refresh. */
export function runForegroundCacheRevalidation<T>(
  cacheKey: string,
  refresh: (lease: CacheRevalidationLease) => Promise<T>,
  writeFamily = cacheKey,
): Promise<T> {
  const pending = getPendingCacheRevalidations();
  const existing = pending.get(cacheKey);
  if (existing?.current.active && !existing.current.background) {
    return existing.current.promise as Promise<T>;
  }

  const { revalidation, writeCoordinator } = startCacheRevalidation(false, writeFamily);
  const coordinator = existing ?? { active: 0, current: revalidation };
  coordinator.current = revalidation;
  coordinator.active += 1;
  pending.set(cacheKey, coordinator);

  let trackedRevalidation!: Promise<T>;
  trackedRevalidation = Promise.resolve()
    .then(() => refresh(createLease(coordinator, writeCoordinator, revalidation)))
    .finally(() => {
      revalidation.active = false;
      coordinator.active -= 1;
      if (coordinator.active === 0 && pending.get(cacheKey) === coordinator) {
        pending.delete(cacheKey);
      }
      finishCacheRevalidation(writeFamily, writeCoordinator);
    });
  revalidation.promise = trackedRevalidation;
  return trackedRevalidation;
}

/** Run every computation while still ordering writes to one physical family. */
export function runUncoalescedForegroundCacheRevalidation<T>(
  writeFamily: string,
  refresh: (lease: CacheRevalidationLease) => Promise<T>,
): Promise<T> {
  return refresh({
    async write(key, write) {
      // Nested App Router computations are intentionally not coalesced. Claim
      // the physical write only when the computation finishes so, like
      // Next.js, the latest completed callback owns the cached value.
      const { revalidation, writeCoordinator } = startCacheRevalidation(false, writeFamily);
      const coordinator = { active: 1, current: revalidation };
      try {
        await createLease(coordinator, writeCoordinator, revalidation).write(key, write);
      } finally {
        revalidation.active = false;
        coordinator.active -= 1;
        finishCacheRevalidation(writeFamily, writeCoordinator);
      }
    },
  });
}

async function repairCurrentWrite(claim: CacheWriteClaim): Promise<void> {
  while (true) {
    const current = claim.current;
    const committed = claim.committed;
    await committed?.();
    if (claim.current === current && claim.committed === committed) return;
  }
}

function createLease(
  coordinator: CacheRevalidationCoordinator,
  writeCoordinator: CacheWriteCoordinator,
  revalidation: CacheRevalidation,
): CacheRevalidationLease {
  const isCurrent = () => coordinator.current === revalidation;
  return {
    async write(key, write) {
      if (revalidation.background && !isCurrent()) return;

      let claim = writeCoordinator.claims.get(key);
      if (!claim) {
        claim = { current: revalidation, committed: undefined };
        writeCoordinator.claims.set(key, claim);
      } else if (claim.current.generation < revalidation.generation) {
        claim.current = revalidation;
      } else if (claim.current.generation > revalidation.generation) {
        return;
      }

      await write();
      if (claim.current === revalidation && isCurrent()) {
        claim.committed = write;
      } else {
        await repairCurrentWrite(claim);
      }
    },
  };
}

/**
 * Start at most one background refresh for a logical data-cache key.
 *
 * The caller owns the refresh's execution context and error message. This
 * helper owns only isolate-wide deduplication, cleanup, rejection guarding,
 * and attachment to the triggering request's runtime lifetime.
 */
export function scheduleBackgroundCacheRevalidation(
  cacheKey: string,
  refresh: (lease: CacheRevalidationLease) => Promise<unknown>,
  reportError: (error: unknown) => void,
  writeFamily = cacheKey,
): void {
  const pending = getPendingCacheRevalidations();
  const existing = pending.get(cacheKey);
  if (existing?.current.active) return;

  const { revalidation, writeCoordinator } = startCacheRevalidation(true, writeFamily);
  const coordinator = existing ?? { active: 0, current: revalidation };
  coordinator.current = revalidation;
  coordinator.active += 1;
  pending.set(cacheKey, coordinator);
  const trackedRevalidation = Promise.resolve()
    .then(() => refresh(createLease(coordinator, writeCoordinator, revalidation)))
    .then(() => undefined)
    .catch((error) => {
      reportError(error);
    })
    .finally(() => {
      revalidation.active = false;
      coordinator.active -= 1;
      if (coordinator.active === 0 && pending.get(cacheKey) === coordinator) {
        pending.delete(cacheKey);
      }
      finishCacheRevalidation(writeFamily, writeCoordinator);
    });
  revalidation.promise = trackedRevalidation;
  const executionContext = getRequestExecutionContext();
  if (executionContext) {
    executionContext.waitUntil(trackedRevalidation);
  } else {
    void trackedRevalidation;
  }
}
