/**
 * SSR prefetch primitive implementing "server snapshot" semantics: the
 * server-side handle records every op result; the snapshot is serialised
 * into page props; the browser handle is seeded with the same snapshot so
 * hydration reads answers from memory instead of refetching.
 */

export type PrefetchedGraphState = Record<string, { data: unknown }>;

export type PrefetchStore = {
  browser: boolean;
  read(key: string): { data: unknown } | undefined;
  write(key: string, data: unknown): void;
  snapshot(): PrefetchedGraphState;
  seed(state: PrefetchedGraphState): void;
};

export const opCacheKey = (
  op: string,
  variables: Record<string, unknown>,
): string => `${op}(${JSON.stringify(variables)})`;

export const prefetchStore = (options?: {
  browser?: boolean;
  seedState?: PrefetchedGraphState;
}): PrefetchStore => {
  const held: PrefetchedGraphState = { ...(options?.seedState ?? {}) };

  return {
    browser: options?.browser ?? false,
    read: (key) => held[key],
    write: (key, data) => {
      held[key] = { data };
    },
    snapshot: () => ({ ...held }),
    seed: (incoming) => {
      Object.assign(held, incoming);
    },
  };
};
