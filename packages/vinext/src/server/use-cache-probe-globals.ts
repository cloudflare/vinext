/**
 * Cross-module handoff for the "use cache" hang-detection probe.
 *
 * A symbol on globalThis decouples the dev-server entry point (which installs
 * the worker pool) from the read site inside cache-runtime.ts — avoiding a
 * direct import of dev-only code from the cache module. In any process where the
 * symbol is not set (production, edge, unit tests, the probe worker itself)
 * getUseCacheProbe() returns undefined, which doubles as the recursion guard
 * against a probe spawning another probe.
 */

const SYMBOL: unique symbol = Symbol.for("vinext.dev.useCacheProbe");

/**
 * Serializable view of the outer request store forwarded to the probe worker.
 * The worker rebuilds a real request context from this so cache bodies that
 * read cookies(), headers(), or draftMode() behave the same as in a real fill.
 */
export type UseCacheProbeRequestSnapshot = {
  headers: [string, string][];
  cookieHeader: string | undefined;
  urlPathname: string;
  urlSearch: string;
  rootParams: Record<string, string | string[]>;
  isDraftMode: boolean;
  isHmrRefresh: boolean;
};

/**
 * Probe hook installed by the dev server. Resolves to true if the cache
 * function ran to completion in isolation — the strong signal that shared
 * outer-scope state is deadlocking the main fill. Resolves to false for any
 * other outcome (probe timeout, decode failure, missing module, etc.).
 */
type UseCacheProbe = (args: {
  /** Module path of the file containing the cached function. */
  modulePath: string;
  /** Export name / server reference id of the cached function. */
  id: string;
  /** Cache variant (e.g. "" for default, "remote", "private"). */
  variant: string;
  /** Serialized function arguments (string from stableStringify or RSC encodeReply). */
  encodedArguments: string;
  /** Forwarded request store snapshot so private caches resolve correctly. */
  request: UseCacheProbeRequestSnapshot;
  /** Internal timeout for the probe worker. */
  timeoutMs: number;
}) => Promise<boolean>;

type ProbeHolder = {
  [SYMBOL]?: UseCacheProbe;
};

export function setUseCacheProbe(fn: UseCacheProbe | undefined): void {
  (globalThis as unknown as ProbeHolder)[SYMBOL] = fn;
}

export function getUseCacheProbe(): UseCacheProbe | undefined {
  return (globalThis as unknown as ProbeHolder)[SYMBOL];
}
