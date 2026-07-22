export type ClientNavigationCacheGeneration = {
  advance(): void;
  capture(): number;
  isCurrent(generation: number): boolean;
};

export function createClientNavigationCacheGeneration(): ClientNavigationCacheGeneration {
  let current = 0;

  return {
    advance() {
      current += 1;
    },
    capture() {
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
  };
}

export function invalidateClientNavigationCacheState(
  generation: ClientNavigationCacheGeneration,
  clearCacheState: () => void,
): void {
  // Advance first so publication already waiting on an async body/buffer sees
  // the stale generation even if it resumes while the cache maps are cleared.
  generation.advance();
  clearCacheState();
}
