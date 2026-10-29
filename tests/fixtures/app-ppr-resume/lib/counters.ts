// Per-process counters the e2e reads through /api/counters, to tell what a
// request ran on the server.
type Counters = Record<string, number>;

const store = globalThis as typeof globalThis & { __pprResumeCounters?: Counters };

export function countServerWork(name: string): void {
  const counters = (store.__pprResumeCounters ??= {});
  counters[name] = (counters[name] ?? 0) + 1;
}

export function readServerWork(): Counters {
  return { ...store.__pprResumeCounters };
}
